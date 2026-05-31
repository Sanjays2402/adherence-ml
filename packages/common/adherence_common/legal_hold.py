"""Per-tenant legal hold (litigation hold / preservation order).

Enterprise legal and compliance teams require a way to *freeze* a
customer workspace's data so that ordinary deletion paths (GDPR right
to erasure, scheduled retention sweeps, account close) stop deleting
rows for the duration of a litigation, audit, or regulator request.

Semantics
---------

* A workspace has zero or more legal hold rows. A hold is *active*
  when ``released_at`` is NULL.
* While any active hold exists for a tenant, the following operations
  are blocked at the API/job layer and refused with a structured
  error (HTTP 423 Locked at the route layer):

  - ``DELETE /v1/users/{user_id}/data`` (GDPR erasure) for any
    ``user_id`` that resolves to this tenant's data.
  - ``POST   /v1/admin/retention-policy/sweep`` (scheduled retention
    sweep, both real and dry-run-counted-as-action).

* Reads, exports, writes (predictions, audits, deliveries) are all
  unaffected. The hold only blocks *deletion*. This is the entire
  legal point of a preservation order.
* Placing or releasing a hold is itself a privileged admin action,
  recorded both in the admin audit log and in this table (the hold
  table is a tamper-evident record of who paused/resumed deletion).

The model is registered with :mod:`adherence_common.db` via the
``init_db`` import block.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, String, Text, func, select

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

MIN_REASON_LEN = 10
MAX_REASON_LEN = 4096
MAX_LABEL_LEN = 128
MAX_TICKET_LEN = 128


class LegalHoldError(ValueError):
    """Raised when a legal hold input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise LegalHoldError(f"value too long (max {max_len})")
    return t


def validate_reason(raw: Optional[str]) -> str:
    if raw is None:
        raise LegalHoldError("reason is required")
    s = str(raw).strip()
    if len(s) < MIN_REASON_LEN:
        raise LegalHoldError(
            f"reason must be at least {MIN_REASON_LEN} characters"
        )
    if len(s) > MAX_REASON_LEN:
        raise LegalHoldError(
            f"reason must be at most {MAX_REASON_LEN} characters"
        )
    return s


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class LegalHold(Base):
    """One legal hold row scoped to a tenant.

    A hold is active while ``released_at`` is NULL. The combination of
    ``placed_at``/``released_at`` plus ``placed_by``/``released_by``
    and the immutable ``reason``/``ticket_ref`` gives auditors the
    full provenance of every deletion freeze.
    """

    __tablename__ = "legal_holds"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    label = Column(String(128), nullable=True)
    reason = Column(Text, nullable=False)
    ticket_ref = Column(String(128), nullable=True)
    placed_by = Column(String(128), nullable=False)
    placed_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    released_by = Column(String(128), nullable=True)
    released_at = Column(DateTime, nullable=True, index=True)
    release_reason = Column(Text, nullable=True)


@dataclass(frozen=True)
class LegalHoldView:
    id: int
    tenant_id: str
    label: Optional[str]
    reason: str
    ticket_ref: Optional[str]
    placed_by: str
    placed_at: str
    released_by: Optional[str]
    released_at: Optional[str]
    release_reason: Optional[str]
    active: bool


def _to_view(row: LegalHold) -> LegalHoldView:
    return LegalHoldView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        label=(str(row.label) if row.label is not None else None),
        reason=str(row.reason),
        ticket_ref=(str(row.ticket_ref) if row.ticket_ref is not None else None),
        placed_by=str(row.placed_by),
        placed_at=row.placed_at.isoformat() if row.placed_at else "",
        released_by=(str(row.released_by) if row.released_by is not None else None),
        released_at=(row.released_at.isoformat() if row.released_at else None),
        release_reason=(
            str(row.release_reason) if row.release_reason is not None else None
        ),
        active=(row.released_at is None),
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def place_hold(
    *,
    tenant_id: str,
    reason: str,
    placed_by: str,
    label: Optional[str] = None,
    ticket_ref: Optional[str] = None,
) -> LegalHoldView:
    tid = (tenant_id or "default")[:64]
    cleaned_reason = validate_reason(reason)
    cleaned_label = _clean(label, max_len=MAX_LABEL_LEN)
    cleaned_ticket = _clean(ticket_ref, max_len=MAX_TICKET_LEN)
    actor = (placed_by or "unknown")[:128]
    row = LegalHold(
        tenant_id=tid,
        label=cleaned_label,
        reason=cleaned_reason,
        ticket_ref=cleaned_ticket,
        placed_by=actor,
        placed_at=datetime.utcnow(),
    )
    with session() as s:
        s.add(row)
        s.commit()
        s.refresh(row)
        return _to_view(row)


def release_hold(
    *,
    tenant_id: str,
    hold_id: int,
    released_by: str,
    release_reason: Optional[str] = None,
) -> Optional[LegalHoldView]:
    """Release one hold, scoped strictly to ``tenant_id``.

    Returns the updated view, or None if no matching active hold
    exists for that tenant (cross-tenant lookup returns None even if
    the id exists on another tenant; this is the multi-tenancy gate).
    """
    tid = (tenant_id or "default")[:64]
    cleaned = _clean(release_reason, max_len=MAX_REASON_LEN)
    with session() as s:
        row = s.execute(
            select(LegalHold).where(
                LegalHold.tenant_id == tid,
                LegalHold.id == int(hold_id),
                LegalHold.released_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.released_by = (released_by or "unknown")[:128]
        row.released_at = datetime.utcnow()
        row.release_reason = cleaned
        s.commit()
        s.refresh(row)
        return _to_view(row)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def list_holds(
    *,
    tenant_id: str,
    include_released: bool = True,
    limit: int = 200,
    offset: int = 0,
) -> list[LegalHoldView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(LegalHold).where(LegalHold.tenant_id == tid)
        if not include_released:
            q = q.where(LegalHold.released_at.is_(None))
        q = q.order_by(LegalHold.id.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_hold(*, tenant_id: str, hold_id: int) -> Optional[LegalHoldView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(LegalHold).where(
                LegalHold.tenant_id == tid,
                LegalHold.id == int(hold_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def is_on_hold(tenant_id: str) -> bool:
    """Return True if at least one active hold exists for ``tenant_id``.

    This is the gate the route layer and the retention sweep job call
    before every delete. Best-effort: a DB failure here returns True
    (fail closed: refuse to delete when we cannot prove no hold).
    """
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            n = s.execute(
                select(func.count(LegalHold.id)).where(
                    LegalHold.tenant_id == tid,
                    LegalHold.released_at.is_(None),
                )
            ).scalar_one()
        return int(n or 0) > 0
    except Exception:
        # Fail closed. A preservation order being silently bypassed
        # because the DB hiccupped would be a much worse outcome than
        # a temporary deletion error surfaced to the caller.
        return True


def active_hold_summary(tenant_id: str) -> Optional[LegalHoldView]:
    """Return the most recent *active* hold for the tenant or None."""
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(LegalHold)
            .where(
                LegalHold.tenant_id == tid,
                LegalHold.released_at.is_(None),
            )
            .order_by(LegalHold.id.desc())
            .limit(1)
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


__all__ = [
    "MIN_REASON_LEN",
    "MAX_REASON_LEN",
    "MAX_LABEL_LEN",
    "MAX_TICKET_LEN",
    "LegalHoldError",
    "LegalHold",
    "LegalHoldView",
    "validate_reason",
    "place_hold",
    "release_hold",
    "list_holds",
    "get_hold",
    "is_on_hold",
    "active_hold_summary",
]
