# AI Collaboration Log

## AI Tech Stack
- **Claude Code** (Claude Sonnet) — used in VS Code for all scaffolding, backend, and frontend code generation.

---

## Entry 1 — Project Scaffold

**Stage:** Repository structure, stubbed Dockerfiles, docker-compose.yml wiring. No application logic yet — this commit only proves the three services can build and start.

**Prompt used:**
> I'm building a small uptime monitoring MVP. Set up ONLY the project scaffold — no business logic yet, just structure, stubs, and config that will let the pieces connect once I fill them in.
>
> Stack: Python FastAPI backend, PostgreSQL, Next.js (App Router) frontend, Docker Compose (3 services: db, backend, frontend).
>
> [Full folder structure, Dockerfile, and docker-compose.yml requirements specified explicitly — including an async SQLAlchemy setup reading DATABASE_URL from env, a multi-stage Next.js Docker build, and an explicit instruction that the frontend's backend URL must resolve to `http://localhost:8000` for the browser, not the Docker service name, since fetches happen client-side.]
>
> Do not write any actual monitor/check database models, any API endpoints beyond /health, or any real frontend UI.

**Output:** Generated `/backend`, `/frontend` skeletons, placeholder Dockerfiles, and a `docker-compose.yml` wiring `db` (Postgres), `backend`, and `frontend` — before any application logic existed.

**Why this order:** Integration surface area (service names, exposed ports, DB connection env vars) was decided upfront so backend and frontend code would be written against a fixed contract, rather than retrofitting Docker networking after the fact.

**Course correction found in review:** `docker-compose.yml` initially set `NEXT_PUBLIC_BACKEND_URL` as a runtime `environment:` variable on the frontend service. This doesn't work — Next.js inlines `NEXT_PUBLIC_*` variables into the client bundle at **build time** (during `npm run build`), which runs inside the Dockerfile's build stage, before `docker-compose.yml`'s runtime `environment:` block ever applies. The variable would have resolved to `undefined` in the browser. I caught this by reading the generated Dockerfile and compose file line-by-line before running anything — a static review catch, not a debugging session after hitting a failure. Each file looked individually correct (the Dockerfile's multi-stage build was right, the compose file's `environment:` syntax was right); the bug only existed in how the two interacted, which is exactly the kind of thing that's easy to wave through if you're checking files in isolation instead of tracing the actual execution order. Fixed by passing it as a Docker build `arg` instead: added `ARG NEXT_PUBLIC_BACKEND_URL` + `ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL` in the Dockerfile's build stage, and moved the value to `build.args` in `docker-compose.yml`.

**Verified:** `docker compose up --build` — all three containers healthy, `curl localhost:8000/health` → `{"status":"ok"}`, `localhost:3000` renders the placeholder page.

---

## Entry 2 — Monitor & Check Data Models

**Stage:** SQLAlchemy models for `Monitor` and `Check`, table creation on app startup. No API endpoints yet — isolating the data layer from the CRUD layer so each could be tested independently.

**Prompt used:**
> Add the database models for the uptime monitor. Do NOT add any API endpoints yet, and do NOT add the polling logic.
>
> Define `Monitor` (id, url, created_at) and `Check` (id, monitor_id FK, status_code, response_time_ms, is_up, checked_at), with status_code/response_time_ms nullable (a timed-out or failed check has neither), and monitor_id as a foreign key rather than duplicating the URL on every check row. Add table creation on FastAPI startup via the current non-deprecated lifespan pattern.
>
> After making these changes, explain back to me why status_code/response_time_ms are nullable, and why monitor_id is a foreign key rather than storing the URL directly.

**Output:** Two models with a bidirectional `relationship(back_populates=...)`, `datetime.now(timezone.utc)` for timestamps (correctly timezone-aware, avoiding the deprecated naive `datetime.utcnow()`), and a `create_tables()` function called from FastAPI's `lifespan` context manager.

**Why nullable fields matter:** a failed/timed-out check has no HTTP status code and no meaningful response time — forcing non-null values here would mean inventing fake data for failure cases. `is_up` stays required, since every check must resolve to a definitive state.

**Why FK over duplicating the URL:** storing `monitor_id` instead of the raw URL on every `Check` row avoids duplicating the same string across what will become thousands of rows over time, and means a URL correction only ever needs to happen in one place.

**Verified:** connected directly to the running Postgres container via `psql` and confirmed both tables exist with the correct column types, nullability, and a real foreign-key constraint (`checks_monitor_id_fkey ... REFERENCES monitors(id)`) enforced at the database level — not just assumed correct from the Python model.

---

## Entry 3 — Monitor CRUD Endpoints

**Stage:** `POST /monitors`, `GET /monitors`, `DELETE /monitors/{id}`. Still no polling — this isolates "can data get in and out correctly" from "does the background check loop work," so a failure in one is easy to attribute to the right layer.

**Prompt used:**
> Add API endpoints for registering and listing monitors. Do NOT add the polling/background check logic yet.
>
> POST /monitors (create, 201), GET /monitors (list all, each with its most recent check embedded — do this efficiently, not with a separate query per monitor in a loop), DELETE /monitors/{id} (404 if missing, 204 on success). Validate URLs via Pydantic's HttpUrl.
>
> After this, tell me how GET /monitors avoids a separate query per monitor's latest check, and why that matters at this project's scale.

**Output:** Pydantic schemas using `HttpUrl` for input validation and `from_attributes=True` for output serialization. `GET /monitors` uses a Postgres `DISTINCT ON` subquery (ordered by `monitor_id, checked_at DESC`) aliased and outer-joined against `Monitor` in a single query — the standard "greatest-n-per-group" SQL pattern, avoiding N+1 queries entirely rather than looping per monitor.

**Course correction found in testing:** deleting a monitor that already had `Check` rows threw an unhandled 500. The FK had no `ON DELETE` rule, so Postgres defaulted to `RESTRICT` and rejected the delete. Claude Code surfaced this as a genuine three-way design decision rather than silently picking one — cascade delete (remove history with the monitor), restrict (block the delete, current default), or soft-delete (mark inactive, keep everything) — and explicitly left it for me to decide.

**My decision:** cascade delete. Reasoning: this is an MVP with no stated requirement to retain check history after a monitor is removed, restrict leaves the DELETE endpoint broken for any monitor that's actually been checked (which is every real use case once polling exists), and soft-delete adds application-level state-tracking that's scope beyond what's asked here. Cascade is also the only option of the three that's a pure database-constraint change rather than new application logic — the simplest fix that's still correct, not just the laziest one.

Fixing it required two changes, not one, which is worth documenting precisely:
1. Added `ondelete="CASCADE"` to the FK in `models.py`, so the database itself cascades the delete.
2. Added `passive_deletes=True` to the `Monitor.checks` relationship. Without this, SQLAlchemy's ORM tries to manage the cascade itself in Python before touching the database — on `session.delete(monitor)` it first attempts to null out `monitor_id` on related `Check` rows (its default "disassociate" behavior), which fails against a `NOT NULL` column before the database's `ON DELETE CASCADE` ever runs. `passive_deletes=True` tells the ORM to step back and let the database-level cascade do the actual work.

Since this changed a constraint on an already-existing table (and `create_tables()` only creates missing tables, it doesn't alter existing ones), applying it locally required dropping the `checks` table and letting `create_tables()` recreate it on the next startup — with the image rebuilt *before* the table was dropped, so the recreated table picked up the new constraint rather than the old one.

**Verified:** confirmed `ON DELETE CASCADE` directly in Postgres via `psql` (`\d checks` shows the constraint). Manually tested via `/docs`: created a monitor, confirmed it appears in `GET /monitors` with `latest_check: null`, deleted it, confirmed 204 and an empty list after.

---

## Entry 4 — Background Poller

**Stage:** The core behavior of the whole application — a background loop that actually checks every registered monitor's URL and records the result. Everything before this stored and served data; this is the first piece that produces it.

**Prompt used:**
> Add the background polling logic that actually checks each registered monitor's URL. This is the core behavior of the whole application — implement it carefully.
>
> Check all monitors CONCURRENTLY using httpx.AsyncClient (not sequentially), 5 second timeout per check. is_up = true only on a 2xx response; anything else (3xx/4xx/5xx, timeout, connection error, DNS failure) is down. On failure, record status_code/response_time_ms as null rather than inventing values, and do NOT let one monitor's failure crash or skip the rest of the batch. Wire it into the FastAPI lifespan as a background task: starts on app startup, loops every ~60 seconds, cancelled cleanly on shutdown.
>
> After this, explain back to me: how does the code guarantee one monitor's connection failure doesn't block the others, and what happens if a poll cycle takes longer than 60 seconds — does the next cycle start late, overlap, or something else?

**Output:** `_check_monitor()` wraps each individual request in its own `try/except Exception`, so a failure is caught and converted into a normal `Check` return value (`status_code=None, response_time_ms=None, is_up=False`) before it can ever reach `asyncio.gather` — failure isolation happens per-coroutine, not at the batch level. `run_poll_cycle()` fetches all monitors, checks them concurrently via `asyncio.gather`, and writes all resulting `Check` rows in a single batch commit. `poll_forever()` runs a sleep-then-repeat loop (check cycle, then sleep 60s, then repeat) wrapped in a broad `except Exception` so a cycle-level failure (e.g. a dropped DB connection) can't kill the loop permanently — while `asyncio.CancelledError` is explicitly re-raised first, so a real shutdown signal still propagates instead of being swallowed. Wired into `main.py`'s `lifespan` via `asyncio.create_task`, cancelled and awaited in a `finally` block on shutdown.

**Why failure isolation works structurally, not just in practice:** `asyncio.gather`'s default behavior is to propagate the first exception it sees and leave other tasks running in the background without collecting their results — if any exception reached `gather` directly, one bad monitor really could have derailed the whole batch. By catching inside each `_check_monitor` coroutine before the exception ever reaches `gather`, that failure mode isn't just handled, it's structurally impossible: from `gather`'s perspective, every coroutine always completes normally with a return value.

**Why cycles can't overlap, and what that costs:** the loop only calls `sleep(60)` after a cycle has fully finished (including the DB commit) — so two cycles can never run concurrently by construction. The tradeoff is drift: if a cycle takes 90 seconds, the real cadence becomes 150 seconds for that iteration, not 60. This is an accepted, deliberate simplification rather than an oversight — since every monitor has a 5-second timeout and all monitors in a cycle run concurrently, a full cycle's worst case is bounded by the slowest single monitor (~5s), not the sum of all monitors, so at "a few dozen URLs" this realistically finishes in low single-digit seconds even with several simultaneous timeouts. A fixed-schedule design would avoid the drift entirely but risks genuine overlapping cycles hammering the same URLs twice or racing on DB writes — solving a problem this project's scale doesn't actually have.

**Verified live, not just read for correctness:** registered 4 monitors covering distinct failure modes — a healthy endpoint, a real 404, a connection-refused target, and an unresolvable hostname — ran a real poll cycle, and confirmed each produced exactly one `Check` row with the correct fields: the 404 correctly recorded `status_code: 404, is_up: false` (a real response, not a failure), while connection-refused and DNS-failure both correctly recorded `null/null/false`. Separately proved concurrency empirically rather than assuming it from the code: 3 concurrent requests to a deliberately 2-second-delayed endpoint, using the identical `gather` + `AsyncClient` pattern, completed in 2.01s total — not ~6s, which is what sequential requests would have taken. Also stopped the container and confirmed clean shutdown logs (`Application shutdown complete`, no traceback, no hung-task warning).
