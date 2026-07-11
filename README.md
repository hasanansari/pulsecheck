# Uptime Monitor

A small, single-purpose uptime monitor. Register a URL, and a background poller checks it every ~60 seconds, recording whether it's up, its response time, and the HTTP status code. A dashboard shows the current state of everything you're watching, updating on its own.

Built as a take-home for Epifi. See `AI_LOG.md` for the full AI collaboration log, prompts, and decisions made along the way.

## Setup

Clone the repo, then from the project root:

```
git clone https://github.com/hasanansari/epifi-techscreen.git
cd epifi-techscreen
docker compose up
```

That's it. This brings up three containers: Postgres, the FastAPI backend, and the Next.js frontend.

- Backend: http://localhost:8000 (interactive API docs at http://localhost:8000/docs)
- Frontend: http://localhost:3000

First boot builds all three images, so it can take a minute or two. Once it's up, tables are created automatically and the poller starts checking any registered monitors immediately.

To stop everything:
```
docker compose down
```

To stop and wipe the database (fresh start):
```
docker compose down -v
```

## How it works

- `POST /monitors` registers a URL.
- A background task wakes up every ~60 seconds, checks every registered URL concurrently (not one at a time), and writes a result row for each: status code, response time in ms, and whether it counted as up.
- A URL counts as up only on a 2xx response. Anything else, a 4xx, a 5xx, a timeout, a DNS failure, a connection refusal, counts as down.
- The frontend polls `GET /monitors` every 5 seconds and re-renders the table, so status changes show up without a manual refresh.
- A monitor that's registered but hasn't been checked yet shows as "Pending," not "Down." Those are different things and the UI treats them differently.

## Testing the up/down detection

This is the part the assignment specifically asks to be reproducible, so here's the exact sequence.

1. Bring the stack up with `docker compose up`.
2. Open http://localhost:3000.
3. Add a working URL through the form, for example `https://example.com`. It appears immediately in the table with a gray "Pending" badge and no response time yet, that's expected, it hasn't been checked yet.
4. Add a broken URL through the form. Anything unreachable works, for example `https://this-domain-does-not-exist-xyz123.com` or `http://localhost:59999`. Same thing, it shows up as "Pending" first.
5. Wait for the next poll cycle. The backend checks everything roughly once a minute. You can also watch the backend logs (`docker compose logs -f backend`) to see the poll cycle run.
6. Refresh isn't needed, but within a few seconds of the poll cycle finishing, the frontend's own 5 second polling will pick up the change. The working URL should flip to a green "Up" badge with a real response time. The broken one should flip to a red "Down" badge with no response time.

If you want to test without waiting up to a minute, you can hit the API directly and see the result faster:

```
curl -X POST http://localhost:8000/monitors -H "Content-Type: application/json" -d '{"url": "https://example.com"}'
curl -X POST http://localhost:8000/monitors -H "Content-Type: application/json" -d '{"url": "http://localhost:59999"}'
curl http://localhost:8000/monitors
```

Run the last command again after the next poll cycle and you'll see `latest_check` populated with real values for both.

### A note on false negatives from bot detection

A handful of real world sites (Wikipedia, Stack Overflow, npm's site among them) block generic HTTP clients by user agent, independent of whether the site is actually up. If you register one of these and it shows "Down," that's the site's bot detection rejecting the request, not a bug in the up/down logic itself. This is documented in more detail in `AI_LOG.md`, Entry 6. It was a deliberate decision not to spoof a browser user agent to work around it, since that felt outside the scope of what was asked here.

## Project structure

```
/backend    FastAPI app: models, endpoints, the poller
/frontend   Next.js dashboard, single page
docker-compose.yml
AI_LOG.md   AI collaboration log
```

## Deployment sketch

This would need actual hardening before running in production anywhere, but roughly, here's how I'd host it.

- **Frontend**: static build deployed to a CDN-backed host (Vercel, or an S3 + CloudFront setup if staying inside AWS). Next.js's standalone output already builds a small, deployable artifact, so this maps cleanly.
- **Backend**: containerized and run on a managed container service rather than a VM, something like AWS ECS with Fargate, or Cloud Run if on GCP. Both handle scaling and restarts without needing to manage servers directly, which fits an MVP that isn't trying to own its own infrastructure yet.
- **Database**: a managed Postgres instance (RDS, or Cloud SQL) instead of a self-hosted container. Backups and failover come for free, and it's one less thing to operate manually.
- **Networking**: backend and database sit in a private subnet, only reachable from the backend's own security group. The frontend calls the backend over a public HTTPS endpoint, backend exposed through a load balancer or API gateway, not directly.
- **Config**: the database URL and any other environment specific values get passed in through the platform's own secrets or environment variable management (ECS task definitions, or Cloud Run's environment variables), not committed anywhere.

A rough Terraform sketch of the backend and database piece, not meant to be complete or run as-is:

```hcl
resource "aws_ecs_service" "backend" {
  name            = "uptime-monitor-backend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = [aws_subnet.private.id]
    security_groups = [aws_security_group.backend.id]
  }
}

resource "aws_db_instance" "postgres" {
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"
  db_name        = "uptime_db"
  username       = "uptime_user"
  password       = var.db_password
  publicly_accessible = false
}
```

The poller itself would keep running the same way it does locally, as a background task inside the backend service, since the scale here (a few dozen URLs) doesn't call for a separate queue or worker system. If this grew to thousands of monitored URLs, that's the point where I'd split the poller into its own service so it can scale independently of the API.

## What's intentionally left out

This is an MVP, and a few things are left out on purpose rather than by oversight:

- No auth. Anyone who can reach the API can register or delete monitors. Fine for a local take-home, not fine for anything real.
- No schema migrations. Tables are created with `create_all` on startup, which handles a fresh database but won't alter an existing table if the schema changes later. A real project would use Alembic or similar.
- No historical charting or uptime percentage over time. The data model supports it (every check is stored, not just the latest), but building that view wasn't part of what was asked.
