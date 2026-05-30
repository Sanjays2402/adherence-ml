"""Persistence + lifecycle helpers for intervention deliveries.

Each recommended action coming out of the interventions endpoint can be
persisted as an ``InterventionDelivery`` row in state ``recommended``.
Clients later patch the row's state to ``sent``, ``snoozed``, ``dismissed``,
or ``acted`` via the ack endpoint. The recommender consults the recent
deliveries table to suppress duplicate (user, action) recommendations that
fall inside the cooldown window or that have been snoozed.

Failures here never bubble out to callers; predictions remain the source of
truth and ack tracking is best-effort, like the audit log.
"""
from __future__ import annotations

import contextlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import InterventionDelivery, init_db, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

VALID_STATES = {"recommended", "sent", "snoozed", "dismissed", "acted", "expired"}
SUPPRESSING_STATES = {"recommended", "sent", "snoozed", "acted"}

_INITIALIZED = False


def _ensure_table() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    try:
        init_db()
        _INITIALIZED = True
    except Exception as exc:  # pragma: no cover
        log.warning("delivery_init_failed", error=str(exc))


@dataclass(frozen=True)
class _RecentKey:
    action: str
    suppress_until: datetime


def recent_actions(user_id: str, cooldown_minutes: int) -> dict[str, datetime]:
    """Return {action: suppress_until} for actions still inside cooldown.

    An action is suppressed if either:
      * created_at + cooldown is in the future, OR
      * its current ``snooze_until`` is in the future.

    Dismissed and expired deliveries do not suppress; clients explicitly
    decided not to act on them.
    """
    _ensure_table()
    now = datetime.utcnow()
    cooldown = timedelta(minutes=max(0, cooldown_minutes))
    out: dict[str, datetime] = {}
    try:
        with session() as s:
            rows = list(s.scalars(
                select(InterventionDelivery)
                .where(
                    InterventionDelivery.user_id == user_id,
                    InterventionDelivery.created_at >= now - cooldown,
                )
                .order_by(InterventionDelivery.id.desc())
            ))
    except SQLAlchemyError as exc:  # pragma: no cover
        log.warning("delivery_recent_failed", error=str(exc))
        return out
    for r in rows:
        if r.state not in SUPPRESSING_STATES:
            continue
        until = r.created_at + cooldown
        if r.snooze_until and r.snooze_until > until:
            until = r.snooze_until
        if until <= now:
            continue
        prev = out.get(r.action)
        if prev is None or until > prev:
            out[r.action] = until
    return out


def count_today(user_id: str) -> int:
    """Count deliveries created today (UTC) that consume budget.

    A delivery consumes budget if it was at minimum surfaced to a caller
    (state != ``dismissed`` and != ``expired``). ``dismissed`` rows do
    not count because the caller chose not to notify the user.
    """
    _ensure_table()
    today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        with session() as s:
            rows = list(s.scalars(
                select(InterventionDelivery).where(
                    InterventionDelivery.user_id == user_id,
                    InterventionDelivery.created_at >= today,
                )
            ))
    except SQLAlchemyError as exc:  # pragma: no cover
        log.warning("delivery_count_failed", error=str(exc))
        return 0
    return sum(1 for r in rows if r.state not in {"dismissed", "expired"})


def record_many(
    *,
    request_id: str,
    user_id: str,
    interventions: Iterable[dict],
) -> list[int]:
    """Persist a batch of recommended interventions, returning their ids.

    Each dict must have keys: action, channel, score, target_dose_ids,
    reason. Returns a list of row ids in the same order; an empty list is
    returned on any DB error.
    """
    _ensure_table()
    out: list[int] = []
    now = datetime.utcnow()
    try:
        with session() as s:
            objs = []
            for iv in interventions:
                row = InterventionDelivery(
                    request_id=request_id,
                    user_id=user_id,
                    action=str(iv.get("action", "")),
                    channel=str(iv.get("channel", "")),
                    score=float(iv.get("score", 0.0)),
                    target_dose_ids_csv=",".join(iv.get("target_dose_ids", []) or []),
                    reason=str(iv.get("reason", "")),
                    state="recommended",
                    created_at=now,
                    updated_at=now,
                )
                objs.append(row)
                s.add(row)
            s.commit()
            for r in objs:
                s.refresh(r)
                out.append(r.id)
    except SQLAlchemyError as exc:  # pragma: no cover
        log.warning("delivery_record_failed", error=str(exc))
        return []
    return out


def ack(
    delivery_id: int,
    state: str,
    *,
    acked_by: str | None = None,
    note: str | None = None,
    snooze_minutes: int | None = None,
) -> InterventionDelivery | None:
    """Transition a delivery to a new state. Returns the updated row or None."""
    if state not in VALID_STATES:
        raise ValueError(f"invalid state: {state}")
    _ensure_table()
    with session() as s:
        row = s.get(InterventionDelivery, delivery_id)
        if row is None:
            return None
        row.state = state
        row.updated_at = datetime.utcnow()
        if acked_by:
            row.acked_by = acked_by
        if note:
            row.ack_note = note
        if state == "snoozed":
            mins = max(1, int(snooze_minutes or 60))
            row.snooze_until = datetime.utcnow() + timedelta(minutes=mins)
        s.commit()
        s.refresh(row)
        return row


__all__ = [
    "VALID_STATES",
    "SUPPRESSING_STATES",
    "recent_actions",
    "count_today",
    "record_many",
    "ack",
]
