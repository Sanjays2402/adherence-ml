"""Per-tenant scheduled maintenance window register.

Enterprise vendor questionnaires (CAIQ AIS-04, SIG O.4, SOC 2 CC7.3,
ISO 27001 A.12.1.2) require a documented change-management process
that customers can observe. This module is the per-workspace data
store for that register: each window has a title, description,
category, customer-facing impact rating, UTC start and end, and an
audit-friendly history of who created, updated, or cancelled it.

Semantics
---------

* Strict tenant scoping: every read and write filters on ``tenant_id``;
  there is no cross-tenant code path.
* Cancelling archives the row instead of deleting it.
* ``starts_at`` must be strictly before ``ends_at``. Every update bumps
  a monotonic ``version``.
* ``active_windows(tenant_id, at)`` returns windows whose
  ``[starts_at, ends_at)`` interval contains ``at``. Archived rows are
  never considered active.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, select

from adherence_common.db import Base, session


MIN_TITLE_LEN = 3
MAX_TITLE_LEN = 128
MIN_DESCRIPTION_LEN = 10
MAX_DESCRIPTION_LEN = 4096

MAX_WINDOW_DAYS = 30
MIN_WINDOW_SECONDS = 60

CATEGORIES = (
    "maintenance",
    "upgrade",
    "security_patch",
    "capacity",
    "incident_followup",
)
IMPACTS = ("none", "degraded", "partial_outage", "full_outage")


class MaintenanceError(ValueError):
    """Raised when a maintenance window input is invalid."""


def _required(s: str, *, field: str, min_len: int, max_len: int) -> str:
    if s is None:
        raise MaintenanceError(f"{field} is required")
    t = str(s).strip()
    if len(t) < min_len:
        raise MaintenanceError(f"{field} must be at least {min_len} characters")
    if len(t) > max_len:
        raise MaintenanceError(f"{field} must be at most {max_len} characters")
    return t


def _category(c: str) -> str:
    t = (c or "").strip().lower()
    if t not in CATEGORIES:
        raise MaintenanceError(
            f"category must be one of: {', '.join(CATEGORIES)}"
        )
    return t


def _impact(i: str) -> str:
    t = (i or "").strip().lower()
    if t not in IMPACTS:
        raise MaintenanceError(
            f"impact must be one of: {', '.join(IMPACTS)}"
        )
    return t


def _coerce_dt(value, *, field: str) -> datetime:
    if isinstance(value, datetime):
        return value.replace(microsecond=0)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            raise MaintenanceError(f"{field} is required")
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except ValueError as exc:
            raise MaintenanceError(
                f"{field} is not a valid ISO 8601 timestamp"
            ) from exc
        if dt.tzinfo is not None:
            dt = dt.astimezone(tz=None).replace(tzinfo=None)
        return dt.replace(microsecond=0)
    raise MaintenanceError(f"{field} must be an ISO 8601 timestamp")


def _validate_window(starts_at: datetime, ends_at: datetime) -> None:
    if not isinstance(starts_at, datetime) or not isinstance(ends_at, datetime):
        raise MaintenanceError("starts_at and ends_at are required")
    if ends_at <= starts_at:
        raise MaintenanceError("ends_at must be strictly after starts_at")
    delta = ends_at - starts_at
    if delta < timedelta(seconds=MIN_WINDOW_SECONDS):
        raise MaintenanceError(
            f"window must be at least {MIN_WINDOW_SECONDS} seconds long"
        )
    if delta > timedelta(days=MAX_WINDOW_DAYS):
        raise MaintenanceError(
            f"window must not exceed {MAX_WINDOW_DAYS} days"
        )


class MaintenanceWindow(Base):
    """One scheduled maintenance window, scoped to a tenant."""

    __tablename__ = "maintenance_windows"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "title", "starts_at",
            name="uq_maint_tenant_title_start",
        ),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    title = Column(String(MAX_TITLE_LEN), nullable=False)
    description = Column(Text, nullable=False)
    category = Column(String(32), nullable=False, default="maintenance")
    impact = Column(String(32), nullable=False, default="degraded")
    starts_at = Column(DateTime, nullable=False, index=True)
    ends_at = Column(DateTime, nullable=False, index=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    archived_by = Column(String(128), nullable=True)
    archived_at = Column(DateTime, nullable=True, index=True)
    archive_reason = Column(String(256), nullable=True)


@dataclass(frozen=True)
class MaintenanceView:
    id: int
    tenant_id: str
    title: str
    description: str
    category: str
    impact: str
    starts_at: str
    ends_at: str
    duration_seconds: int
    status: str
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    archived_by: Optional[str]
    archived_at: Optional[str]
    archive_reason: Optional[str]
    active: bool


def _status(row: "MaintenanceWindow", *, now: datetime) -> str:
    if row.archived_at is not None:
        return "cancelled"
    if row.starts_at <= now < row.ends_at:
        return "active"
    if now >= row.ends_at:
        return "completed"
    return "scheduled"


def _to_view(row: MaintenanceWindow, *, now: Optional[datetime] = None) -> MaintenanceView:
    n = now or datetime.utcnow()
    duration = int((row.ends_at - row.starts_at).total_seconds())
    return MaintenanceView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        title=str(row.title),
        description=str(row.description),
        category=str(row.category or "maintenance"),
        impact=str(row.impact or "degraded"),
        starts_at=row.starts_at.isoformat() if row.starts_at else "",
        ends_at=row.ends_at.isoformat() if row.ends_at else "",
        duration_seconds=duration,
        status=_status(row, now=n),
        version=int(row.version or 1),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=(row.updated_at.isoformat() if row.updated_at else None),
        archived_by=(str(row.archived_by) if row.archived_by else None),
        archived_at=(row.archived_at.isoformat() if row.archived_at else None),
        archive_reason=(str(row.archive_reason) if row.archive_reason else None),
        active=(row.archived_at is None),
    )


def create_window(
    *,
    tenant_id: str,
    title: str,
    description: str,
    category: str,
    impact: str,
    starts_at,
    ends_at,
    created_by: str,
) -> MaintenanceView:
    tid = (tenant_id or "default")[:64]
    ctitle = _required(title, field="title", min_len=MIN_TITLE_LEN, max_len=MAX_TITLE_LEN)
    cdesc = _required(
        description,
        field="description",
        min_len=MIN_DESCRIPTION_LEN,
        max_len=MAX_DESCRIPTION_LEN,
    )
    ccat = _category(category)
    cimp = _impact(impact)
    s = _coerce_dt(starts_at, field="starts_at")
    e = _coerce_dt(ends_at, field="ends_at")
    _validate_window(s, e)
    actor = (created_by or "unknown")[:128]
    with session() as db:
        clash = db.execute(
            select(MaintenanceWindow).where(
                MaintenanceWindow.tenant_id == tid,
                MaintenanceWindow.title == ctitle,
                MaintenanceWindow.starts_at == s,
                MaintenanceWindow.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if clash is not None:
            raise MaintenanceError(
                f"a window titled {ctitle!r} is already scheduled to start at {s.isoformat()}"
            )
        row = MaintenanceWindow(
            tenant_id=tid,
            title=ctitle,
            description=cdesc,
            category=ccat,
            impact=cimp,
            starts_at=s,
            ends_at=e,
            version=1,
            created_by=actor,
            created_at=datetime.utcnow(),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return _to_view(row)


def update_window(
    *,
    tenant_id: str,
    window_id: int,
    updated_by: str,
    title: Optional[str] = None,
    description: Optional[str] = None,
    category: Optional[str] = None,
    impact: Optional[str] = None,
    starts_at=None,
    ends_at=None,
) -> Optional[MaintenanceView]:
    tid = (tenant_id or "default")[:64]
    with session() as db:
        row = db.execute(
            select(MaintenanceWindow).where(
                MaintenanceWindow.tenant_id == tid,
                MaintenanceWindow.id == int(window_id),
                MaintenanceWindow.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if title is not None:
            row.title = _required(
                title, field="title", min_len=MIN_TITLE_LEN, max_len=MAX_TITLE_LEN
            )
        if description is not None:
            row.description = _required(
                description,
                field="description",
                min_len=MIN_DESCRIPTION_LEN,
                max_len=MAX_DESCRIPTION_LEN,
            )
        if category is not None:
            row.category = _category(category)
        if impact is not None:
            row.impact = _impact(impact)
        new_start = _coerce_dt(starts_at, field="starts_at") if starts_at is not None else row.starts_at
        new_end = _coerce_dt(ends_at, field="ends_at") if ends_at is not None else row.ends_at
        _validate_window(new_start, new_end)
        row.starts_at = new_start
        row.ends_at = new_end
        row.version = int(row.version or 1) + 1
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(row)
        return _to_view(row)


def archive_window(
    *,
    tenant_id: str,
    window_id: int,
    archived_by: str,
    reason: Optional[str] = None,
) -> Optional[MaintenanceView]:
    tid = (tenant_id or "default")[:64]
    creason = None
    if reason is not None:
        r = str(reason).strip()
        if len(r) > 256:
            raise MaintenanceError("archive reason must be at most 256 characters")
        creason = r or None
    with session() as db:
        row = db.execute(
            select(MaintenanceWindow).where(
                MaintenanceWindow.tenant_id == tid,
                MaintenanceWindow.id == int(window_id),
                MaintenanceWindow.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.archived_by = (archived_by or "unknown")[:128]
        row.archived_at = datetime.utcnow()
        row.archive_reason = creason
        db.commit()
        db.refresh(row)
        return _to_view(row)


def list_windows(
    *,
    tenant_id: str,
    include_archived: bool = False,
    limit: int = 200,
    offset: int = 0,
    now: Optional[datetime] = None,
) -> list[MaintenanceView]:
    tid = (tenant_id or "default")[:64]
    with session() as db:
        q = select(MaintenanceWindow).where(MaintenanceWindow.tenant_id == tid)
        if not include_archived:
            q = q.where(MaintenanceWindow.archived_at.is_(None))
        q = q.order_by(MaintenanceWindow.starts_at.desc()).offset(int(offset)).limit(int(limit))
        n = now or datetime.utcnow()
        return [_to_view(r, now=n) for r in db.execute(q).scalars().all()]


def get_window(*, tenant_id: str, window_id: int) -> Optional[MaintenanceView]:
    tid = (tenant_id or "default")[:64]
    with session() as db:
        row = db.execute(
            select(MaintenanceWindow).where(
                MaintenanceWindow.tenant_id == tid,
                MaintenanceWindow.id == int(window_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def active_windows(
    tenant_id: str, *, at: Optional[datetime] = None
) -> list[MaintenanceView]:
    tid = (tenant_id or "default")[:64]
    n = (at or datetime.utcnow()).replace(microsecond=0)
    try:
        with session() as db:
            q = select(MaintenanceWindow).where(
                MaintenanceWindow.tenant_id == tid,
                MaintenanceWindow.archived_at.is_(None),
                MaintenanceWindow.starts_at <= n,
                MaintenanceWindow.ends_at > n,
            ).order_by(MaintenanceWindow.starts_at.asc())
            return [_to_view(r, now=n) for r in db.execute(q).scalars().all()]
    except Exception:
        return []


def upcoming_count(tenant_id: str, *, at: Optional[datetime] = None) -> int:
    tid = (tenant_id or "default")[:64]
    n = at or datetime.utcnow()
    try:
        with session() as db:
            return len(
                db.execute(
                    select(MaintenanceWindow).where(
                        MaintenanceWindow.tenant_id == tid,
                        MaintenanceWindow.archived_at.is_(None),
                        MaintenanceWindow.starts_at > n,
                    )
                ).all()
            )
    except Exception:
        return 0


def active_count(tenant_id: str, *, at: Optional[datetime] = None) -> int:
    return len(active_windows(tenant_id, at=at))


__all__ = [
    "CATEGORIES",
    "IMPACTS",
    "MAX_WINDOW_DAYS",
    "MIN_WINDOW_SECONDS",
    "MIN_TITLE_LEN",
    "MAX_TITLE_LEN",
    "MIN_DESCRIPTION_LEN",
    "MAX_DESCRIPTION_LEN",
    "MaintenanceError",
    "MaintenanceWindow",
    "MaintenanceView",
    "create_window",
    "update_window",
    "archive_window",
    "list_windows",
    "get_window",
    "active_windows",
    "active_count",
    "upcoming_count",
]
