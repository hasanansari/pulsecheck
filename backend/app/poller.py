import asyncio
import logging
import time

import httpx
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models import Check, Monitor

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 5.0
POLL_INTERVAL_SECONDS = 60.0


async def _check_monitor(client: httpx.AsyncClient, monitor: Monitor) -> Check:
    start = time.monotonic()
    try:
        response = await client.get(monitor.url, timeout=REQUEST_TIMEOUT_SECONDS)
    except Exception:
        return Check(
            monitor_id=monitor.id,
            status_code=None,
            response_time_ms=None,
            is_up=False,
        )

    elapsed_ms = (time.monotonic() - start) * 1000
    return Check(
        monitor_id=monitor.id,
        status_code=response.status_code,
        response_time_ms=elapsed_ms,
        is_up=200 <= response.status_code < 300,
    )


async def run_poll_cycle() -> None:
    async with AsyncSessionLocal() as session:
        monitors = (await session.execute(select(Monitor))).scalars().all()
        if not monitors:
            return

        async with httpx.AsyncClient(follow_redirects=True) as client:
            checks = await asyncio.gather(
                *(_check_monitor(client, monitor) for monitor in monitors)
            )

        session.add_all(checks)
        await session.commit()


async def poll_forever(interval_seconds: float = POLL_INTERVAL_SECONDS) -> None:
    while True:
        try:
            await run_poll_cycle()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Poll cycle failed")
        await asyncio.sleep(interval_seconds)
