"""Break-glass log for cross-tenant admin access.

In a multi-tenant SaaS, vendor admins can technically read or mutate
data that belongs to a customer tenant. Enterprise buyers will not
sign without an answer to "what stops a vendor employee from quietly
looking at our data, and how do we see it after the fact?"

This module is that answer:

* Every time an admin operates on a tenant other than their own (or on
  the fleet-wide ``*`` scope), the route layer must call
  :func:`record` with a non-empty justification supplied by the caller
  via the ``X-Break-Glass-Justification`` header. Without it the route
  returns ``400 break_glass_required``.
* Rows are append-only, indexed by ``target_tenant``, and exposed back
  to the impacted tenant's owners through
  ``/v1/admin/break-glass`` so the customer can see who looked at
  their data and why.

The model lives alongside the rest of ``adherence_common.db`` and is
picked up by :func:`adherence_common.db.init_db`.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from sqlalchemy import Column, DateTime, Integer, String, Text, func, select

from adherence_common.db import Base, session


JUSTIFICATION_HEADER = "X-Break-Glass-Justification"
MIN_JUSTIFICATION_LEN = 10
MAX_JUSTIFICATION_LEN = 2048


class BreakGlassError(ValueError):
    """Raised when a break-glass justification is missing or invalid."""


def validate_justification(raw: str | None) -> str:
    """Return a cleaned justification or raise :class:`BreakGlassError`."""
    if raw is None:
        raise BreakGlassError(
            f"missing {JUSTIFICATION_HEADER} header"
        )
    s = str(raw).strip()
    if not s:
        raise BreakGlassError(
            f"{JUSTIFICATION_HEADER} must not be empty"
        )
    if len(s) < MIN_JUSTIFICATION_LEN:
        raise BreakGlassError(
            f"{JUSTIFICATION_HEADER} must be at least "
            f"{MIN_JUSTIFICATION_LEN} characters"
        )
    if len(s) > MAX_JUSTIFICATION_LEN:
        raise BreakGlassError(
            f"{JUSTIFICATION_HEADER} must be at most "
            f"{MAX_JUSTIFICATION_LEN} characters"
        )
    return s


class BreakGlassEvent(Base):
    """One row per accepted cross-tenant admin access."""

    __tablename__ = "break_glass_events"
    id = Column(Integer, primary_key=True, autoincrement=True)
    created_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    caller = Column(String(128), nullable=False, index=True)
    caller_role = Column(String(32), nullable=False)
    source_tenant = Column(String(64), nullable=False, index=True)
    target_tenant = Column(String(64), nullable=False, index=True)
    route = Column(String(256), nullable=False)
    method = Column(String(8), nullable=False)
    justification = Column(Text, nullable=False)
    client_ip = Column(String(64), nullable=True)
    request_id = Column(String(64), nullable=True, index=True)


@dataclass(frozen=True)
class BreakGlassView:
    id: int
    created_at: datetime
    caller: str
    caller_role: str
    source_tenant: str
    target_tenant: str
    route: str
    method: str
    justification: str
    client_ip: str | None
    request_id: str | None


def _to_view(r: BreakGlassEvent) -> BreakGlassView:
    return BreakGlassView(
        id=int(r.id),
        created_at=r.created_at,
        caller=str(r.caller),
        caller_role=str(r.caller_role),
        source_tenant=str(r.source_tenant),
        target_tenant=str(r.target_tenant),
        route=str(r.route),
        method=str(r.method),
        justification=str(r.justification),
        client_ip=(str(r.client_ip) if r.client_ip is not None else None),
        request_id=(str(r.request_id) if r.request_id is not None else None),
    )


def record(
    *,
    caller: str,
    caller_role: str,
    source_tenant: str,
    target_tenant: str,
    route: str,
    method: str,
    justification: str,
    client_ip: str | None = None,
    request_id: str | None = None,
) -> BreakGlassView:
    """Persist a break-glass event. Raises on DB failure."""
    cleaned = validate_justification(justification)
    row = BreakGlassEvent(
        caller=caller[:128],
        caller_role=caller_role[:32],
        source_tenant=source_tenant[:64],
        target_tenant=target_tenant[:64],
        route=route[:256],
        method=method[:8],
        justification=cleaned,
        client_ip=(client_ip[:64] if client_ip else None),
        request_id=(request_id[:64] if request_id else None),
    )
    with session() as s:
        s.add(row)
        s.commit()
        s.refresh(row)
        return _to_view(row)


def list_events(
    *,
    target_tenant: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[BreakGlassView]:
    with session() as s:
        q = select(BreakGlassEvent).order_by(BreakGlassEvent.id.desc())
        if target_tenant is not None:
            q = q.where(BreakGlassEvent.target_tenant == target_tenant)
        q = q.offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def count_events(*, target_tenant: str | None = None) -> int:
    with session() as s:
        q = select(func.count(BreakGlassEvent.id))
        if target_tenant is not None:
            q = q.where(BreakGlassEvent.target_tenant == target_tenant)
        return int(s.execute(q).scalar_one() or 0)


__all__ = [
    "JUSTIFICATION_HEADER",
    "MIN_JUSTIFICATION_LEN",
    "MAX_JUSTIFICATION_LEN",
    "BreakGlassError",
    "BreakGlassEvent",
    "BreakGlassView",
    "validate_justification",
    "record",
    "list_events",
    "count_events",
]
