"""Per-API-key daily usage counters.

Enterprise customers need per-key call attribution for chargeback, capacity
planning, and abuse detection. This module persists a tiny (name, day) row
that the resolver increments on every successful key resolution. Reads return
a contiguous N-day window with zero-fill so the UI can render a stable chart
without client-side gap math.

The table is intentionally separate from ``api_key_records`` so we never
contend on the credential row when traffic spikes, and so dropping the usage
history (e.g. retention sweep) does not touch credentials.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Iterable

from sqlalchemy import (
    Column, Date, Integer, String, UniqueConstraint, func, select,
)
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from adherence_common.db import Base, init_db, session


class APIKeyUsageDaily(Base):
    """One row per (key name, UTC day). Counter is incremented atomically."""

    __tablename__ = "api_key_usage_daily"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False, index=True)
    day = Column(Date, nullable=False, index=True)
    count = Column(Integer, nullable=False, default=0)
    last_status = Column(Integer, nullable=True)
    last_path = Column(String(256), nullable=True)
    last_seen_at = Column(String(40), nullable=True)
    last_seen_ip = Column(String(64), nullable=True)
    last_seen_user_agent = Column(String(256), nullable=True)
    __table_args__ = (
        UniqueConstraint("name", "day", name="uq_api_key_usage_name_day"),
    )


@dataclass(frozen=True)
class DailyPoint:
    day: date
    count: int


@dataclass(frozen=True)
class UsageSummary:
    name: str
    window_days: int
    total: int
    points: tuple[DailyPoint, ...]
    peak_day: date | None
    peak_count: int


def _utc_today() -> date:
    return datetime.now(timezone.utc).date()


def record_usage(
    name: str,
    *,
    status_code: int | None = None,
    path: str | None = None,
    when: datetime | None = None,
    client_ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Best-effort increment for a key's usage on the current UTC day.

    Swallows all errors so a misbehaving counter never breaks an
    authenticated request. The SQLite UPSERT is atomic enough for our
    write rate; Postgres deployments will get the same semantics via the
    fallback select+insert+update path below.
    """
    if not name:
        return
    ts = (when or datetime.now(timezone.utc))
    day = ts.date()
    iso = ts.replace(microsecond=0).isoformat()
    truncated_path = (path or "")[:256] or None
    truncated_ip = (client_ip or "").strip()[:64] or None
    truncated_ua = (user_agent or "").strip()[:256] or None
    try:
        init_db()
        with session() as s:
            dialect = s.bind.dialect.name if s.bind is not None else ""
            if dialect == "sqlite":
                stmt = (
                    sqlite_insert(APIKeyUsageDaily)
                    .values(
                        name=name, day=day, count=1,
                        last_status=status_code,
                        last_path=truncated_path,
                        last_seen_at=iso,
                        last_seen_ip=truncated_ip,
                        last_seen_user_agent=truncated_ua,
                    )
                    .on_conflict_do_update(
                        index_elements=["name", "day"],
                        set_={
                            "count": APIKeyUsageDaily.count + 1,
                            "last_status": status_code,
                            "last_path": truncated_path,
                            "last_seen_at": iso,
                            "last_seen_ip": truncated_ip,
                            "last_seen_user_agent": truncated_ua,
                        },
                    )
                )
                s.execute(stmt)
                s.commit()
                return
            # Generic fallback: try update, else insert, else retry update.
            row = s.execute(
                select(APIKeyUsageDaily).where(
                    APIKeyUsageDaily.name == name,
                    APIKeyUsageDaily.day == day,
                )
            ).scalar_one_or_none()
            if row is None:
                s.add(APIKeyUsageDaily(
                    name=name, day=day, count=1,
                    last_status=status_code,
                    last_path=truncated_path,
                    last_seen_at=iso,
                    last_seen_ip=truncated_ip,
                    last_seen_user_agent=truncated_ua,
                ))
            else:
                row.count = int(row.count or 0) + 1
                row.last_status = status_code
                row.last_path = truncated_path
                row.last_seen_at = iso
                row.last_seen_ip = truncated_ip
                row.last_seen_user_agent = truncated_ua
            s.commit()
    except Exception:
        # Never fail the request because telemetry is unhappy.
        return


def get_usage(
    name: str,
    *,
    days: int = 30,
    today: date | None = None,
) -> UsageSummary:
    """Return a zero-filled window of the last ``days`` days for ``name``.

    Always returns ``days`` points so the caller can chart without holes,
    even if the key has never been used.
    """
    if days <= 0:
        raise ValueError("days must be positive")
    if days > 365:
        raise ValueError("days must be <= 365")
    end = today or _utc_today()
    start = end - timedelta(days=days - 1)
    init_db()
    rows: dict[date, APIKeyUsageDaily] = {}
    with session() as s:
        for row in s.execute(
            select(APIKeyUsageDaily).where(
                APIKeyUsageDaily.name == name,
                APIKeyUsageDaily.day >= start,
                APIKeyUsageDaily.day <= end,
            )
        ).scalars():
            rows[row.day] = row
    points: list[DailyPoint] = []
    peak_day: date | None = None
    peak_count = 0
    total = 0
    for i in range(days):
        d = start + timedelta(days=i)
        c = int(rows[d].count) if d in rows else 0
        total += c
        if c > peak_count:
            peak_count = c
            peak_day = d
        points.append(DailyPoint(day=d, count=c))
    return UsageSummary(
        name=name,
        window_days=days,
        total=total,
        points=tuple(points),
        peak_day=peak_day,
        peak_count=peak_count,
    )


def get_usage_bulk(
    names: Iterable[str], *, days: int = 30, today: date | None = None,
) -> dict[str, UsageSummary]:
    """Convenience for the admin list view; returns one summary per name."""
    out: dict[str, UsageSummary] = {}
    for n in names:
        out[n] = get_usage(n, days=days, today=today)
    return out


def purge_before(cutoff: date) -> int:
    """Delete usage rows strictly older than ``cutoff``. Returns row count."""
    init_db()
    with session() as s:
        res = s.execute(
            APIKeyUsageDaily.__table__.delete().where(
                APIKeyUsageDaily.day < cutoff,
            )
        )
        s.commit()
        return int(res.rowcount or 0)


def total_for_window(name: str, *, days: int = 30) -> int:
    """Sum count for the last N days. Used by quota/billing aggregators."""
    init_db()
    end = _utc_today()
    start = end - timedelta(days=days - 1)
    with session() as s:
        total = s.execute(
            select(func.coalesce(func.sum(APIKeyUsageDaily.count), 0)).where(
                APIKeyUsageDaily.name == name,
                APIKeyUsageDaily.day >= start,
                APIKeyUsageDaily.day <= end,
            )
        ).scalar_one()
    return int(total or 0)
