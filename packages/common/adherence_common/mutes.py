"""Per-user intervention mute store.

A mute is a TTL-based opt-out. While active, the interventions endpoint
skips delivery for the user and reports the mute on the response so
callers can show the right UI state.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select

from adherence_common.db import UserMute, init_db, session


@dataclass
class MuteState:
    user_id: str
    muted_until: datetime
    reason: str | None
    set_by: str | None
    active: bool


def _to_state(row: UserMute, now: datetime) -> MuteState:
    return MuteState(
        user_id=row.user_id,
        muted_until=row.muted_until,
        reason=row.reason,
        set_by=row.set_by,
        active=row.muted_until > now,
    )


def set_mute(
    user_id: str,
    *,
    duration_minutes: int,
    reason: str | None = None,
    set_by: str | None = None,
    now: datetime | None = None,
) -> MuteState:
    if duration_minutes < 1:
        raise ValueError("duration_minutes must be >= 1")
    if duration_minutes > 60 * 24 * 90:
        raise ValueError("duration_minutes must be <= 90 days")
    init_db()
    now = now or datetime.utcnow()
    until = now + timedelta(minutes=duration_minutes)
    with session() as s:
        row = s.execute(
            select(UserMute).where(UserMute.user_id == user_id)
        ).scalar_one_or_none()
        if row is None:
            row = UserMute(
                user_id=user_id, muted_until=until,
                reason=reason, set_by=set_by,
                created_at=now, updated_at=now,
            )
            s.add(row)
        else:
            row.muted_until = until
            row.reason = reason
            row.set_by = set_by
            row.updated_at = now
        s.commit()
        s.refresh(row)
        return _to_state(row, now)


def clear_mute(user_id: str, *, now: datetime | None = None) -> bool:
    """Force the mute to expire immediately. Returns True if a row existed."""
    init_db()
    now = now or datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(UserMute).where(UserMute.user_id == user_id)
        ).scalar_one_or_none()
        if row is None:
            return False
        row.muted_until = now
        row.updated_at = now
        s.commit()
        return True


def get_mute(user_id: str, *, now: datetime | None = None) -> MuteState | None:
    init_db()
    now = now or datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(UserMute).where(UserMute.user_id == user_id)
        ).scalar_one_or_none()
        if row is None:
            return None
        return _to_state(row, now)


def is_muted(user_id: str, *, now: datetime | None = None) -> MuteState | None:
    """Return the active MuteState or None if not currently muted."""
    st = get_mute(user_id, now=now)
    if st is None or not st.active:
        return None
    return st


def list_active(now: datetime | None = None) -> list[MuteState]:
    init_db()
    now = now or datetime.utcnow()
    with session() as s:
        rows = list(s.scalars(
            select(UserMute).where(UserMute.muted_until > now)
            .order_by(UserMute.muted_until.asc())
        ))
    return [_to_state(r, now) for r in rows]
