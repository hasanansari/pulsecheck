from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.database import create_tables, get_db
from app.models import Check, Monitor
from app.schemas import CheckOut, MonitorCreate, MonitorOut


@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_tables()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/monitors", response_model=MonitorOut, status_code=status.HTTP_201_CREATED)
async def create_monitor(
    payload: MonitorCreate, db: AsyncSession = Depends(get_db)
) -> MonitorOut:
    monitor = Monitor(url=str(payload.url))
    db.add(monitor)
    await db.commit()
    await db.refresh(monitor)
    return MonitorOut(
        id=monitor.id, url=monitor.url, created_at=monitor.created_at, latest_check=None
    )


@app.get("/monitors", response_model=list[MonitorOut])
async def list_monitors(db: AsyncSession = Depends(get_db)) -> list[MonitorOut]:
    # One row per monitor_id, keeping only its most recent check (Postgres DISTINCT ON).
    latest_checks_subq = (
        select(Check)
        .distinct(Check.monitor_id)
        .order_by(Check.monitor_id, Check.checked_at.desc())
        .subquery()
    )
    latest_check = aliased(Check, latest_checks_subq)

    stmt = (
        select(Monitor, latest_check)
        .outerjoin(latest_check, Monitor.id == latest_check.monitor_id)
        .order_by(Monitor.id)
    )
    result = await db.execute(stmt)

    return [
        MonitorOut(
            id=monitor.id,
            url=monitor.url,
            created_at=monitor.created_at,
            latest_check=CheckOut.model_validate(check) if check is not None else None,
        )
        for monitor, check in result.all()
    ]


@app.delete("/monitors/{monitor_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_monitor(monitor_id: int, db: AsyncSession = Depends(get_db)) -> None:
    monitor = await db.get(Monitor, monitor_id)
    if monitor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Monitor not found")
    await db.delete(monitor)
    await db.commit()
