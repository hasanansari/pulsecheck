from datetime import datetime

from pydantic import BaseModel, ConfigDict, HttpUrl


class MonitorCreate(BaseModel):
    url: HttpUrl


class CheckOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status_code: int | None
    response_time_ms: float | None
    is_up: bool
    checked_at: datetime


class MonitorOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    url: str
    created_at: datetime
    latest_check: CheckOut | None = None
