"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const POLL_INTERVAL_MS = 5000;

type CheckOut = {
  id: number;
  status_code: number | null;
  response_time_ms: number | null;
  is_up: boolean;
  checked_at: string;
};

type MonitorOut = {
  id: number;
  url: string;
  created_at: string;
  latest_check: CheckOut | null;
};

type LoadState = "loading" | "error" | "ready";

async function fetchMonitors(): Promise<MonitorOut[]> {
  const res = await fetch(`${BACKEND_URL}/monitors`);
  if (!res.ok) {
    throw new Error(`GET /monitors failed (${res.status})`);
  }
  return res.json();
}

function extractErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((entry) =>
          entry && typeof entry === "object" && "msg" in entry
            ? String((entry as { msg: unknown }).msg)
            : null
        )
        .filter((msg): msg is string => Boolean(msg));
      if (messages.length > 0) return messages.join("; ");
    }
  }
  return `Request failed (${status})`;
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  return date.toLocaleString();
}

function StatusBadge({ check }: { check: CheckOut | null }) {
  if (check === null) {
    return <span className="badge badge-pending">Pending</span>;
  }
  return check.is_up ? (
    <span className="badge badge-up">Up</span>
  ) : (
    <span className="badge badge-down">Down</span>
  );
}

export default function Home() {
  const [status, setStatus] = useState<LoadState>("loading");
  const [monitors, setMonitors] = useState<MonitorOut[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);

  const [urlInput, setUrlInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isFetchingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      try {
        const data = await fetchMonitors();
        if (cancelled) return;
        setMonitors(data);
        setStatus("ready");
        setPollError(null);
      } catch {
        if (cancelled) return;
        setStatus((prev) => (prev === "ready" ? "ready" : "error"));
        setPollError("Lost connection to the backend — showing last known data.");
      } finally {
        isFetchingRef.current = false;
      }
    };

    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${BACKEND_URL}/monitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setFormError(extractErrorMessage(body, res.status));
        return;
      }
      const created: MonitorOut = await res.json();
      setMonitors((prev) => [...prev, created]);
      setStatus("ready");
      setUrlInput("");
    } catch {
      setFormError("Could not reach the backend. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      const res = await fetch(`${BACKEND_URL}/monitors/${id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        setMonitors((prev) => prev.filter((m) => m.id !== id));
      }
    } catch {
      // Leave the row in place; the next poll reconciles with the backend.
    }
  }

  return (
    <main className="page">
      <h1>Uptime Monitor</h1>

      <form className="add-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="https://example.com"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          disabled={submitting}
          required
        />
        <button type="submit" disabled={submitting}>
          {submitting ? "Adding…" : "Add monitor"}
        </button>
      </form>
      {formError && <p className="form-error">{formError}</p>}

      {status === "loading" && <p className="status-message">Loading monitors…</p>}

      {status === "error" && (
        <p className="banner banner-error">
          Could not reach the backend at {BACKEND_URL}.
        </p>
      )}

      {status === "ready" && (
        <>
          {pollError && <p className="banner banner-warning">{pollError}</p>}

          {monitors.length === 0 ? (
            <p className="status-message">No monitors yet — add one above to get started.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Status</th>
                  <th>Response Time</th>
                  <th>Last Checked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {monitors.map((monitor) => (
                  <tr key={monitor.id}>
                    <td>{monitor.url}</td>
                    <td>
                      <StatusBadge check={monitor.latest_check} />
                    </td>
                    <td>
                      {monitor.latest_check?.response_time_ms != null
                        ? `${Math.round(monitor.latest_check.response_time_ms)} ms`
                        : "—"}
                    </td>
                    <td>
                      {monitor.latest_check
                        ? formatRelativeTime(monitor.latest_check.checked_at)
                        : "—"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="delete-button"
                        onClick={() => handleDelete(monitor.id)}
                        aria-label={`Delete monitor for ${monitor.url}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
