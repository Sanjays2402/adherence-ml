"""Per-workspace data residency.

Enterprise procurement (especially EU healthcare and US public sector)
requires a contractually enforceable promise that customer data lives
in a specific geographic region. We already make that promise in
``docs/SUBPROCESSORS.md``; this module makes it real in code.

Each tenant pins itself to one of :data:`ALLOWED_REGIONS`. The choice
is:

* surfaced on every response as the ``X-Data-Residency`` header so
  callers (and security reviewers running curl) can see it without
  reading docs;
* recorded in the admin audit chain on every change so SOC2 reviewers
  can trace who moved a workspace and when;
* tenant-scoped: changing ``acme``'s region never affects ``globex``.

The actual storage / worker pinning is a deployment concern (handled by
the operator at the infra layer per ``docs/SUBPROCESSORS.md``); this
module is the single source of truth the API consults at runtime so
operators, dashboards, and runbooks all agree on what region a given
workspace is in.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, Integer, String, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


# Region codes are deliberately short, stable, lowercase, and audited
# against this set on every write. Adding a region is an explicit code
# change (and a subprocessor doc update) so operators cannot silently
# park data in an undeclared region by typo.
ALLOWED_REGIONS: frozenset[str] = frozenset({"us", "eu"})
DEFAULT_REGION: str = "us"


def _normalize(region: str) -> str:
    return str(region or "").strip().lower()


def is_allowed(region: str) -> bool:
    return _normalize(region) in ALLOWED_REGIONS


class WorkspaceResidency(Base):
    """One row per tenant. Absence means the tenant uses
    :data:`DEFAULT_REGION` (typically ``us``).
    """

    __tablename__ = "workspace_residency"

    tenant_id = Column(String(64), primary_key=True)
    region = Column(String(8), nullable=False)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


@dataclass(frozen=True)
class ResidencyView:
    tenant_id: str
    region: str
    updated_at: int
    updated_by: Optional[str]


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _to_view(row: WorkspaceResidency) -> ResidencyView:
    return ResidencyView(
        tenant_id=str(row.tenant_id),
        region=str(row.region),
        updated_at=int(row.updated_at),
        updated_by=(str(row.updated_by) if row.updated_by else None),
    )


def get_residency(tenant_id: str) -> Optional[ResidencyView]:
    """Return the residency row for ``tenant_id`` or ``None`` if unset."""
    if not tenant_id:
        return None
    try:
        with session() as s:
            row = s.execute(
                select(WorkspaceResidency).where(
                    WorkspaceResidency.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_view(row) if row else None
    except SQLAlchemyError as exc:
        log.warning("residency_get_failed", tenant=tenant_id, error=str(exc))
        return None


def get_region(tenant_id: str) -> str:
    """Return the active region for ``tenant_id``, falling back to
    :data:`DEFAULT_REGION` when the tenant has not pinned a region.

    This is the single function the runtime should consult when it needs
    to decide where a tenant's data lives (e.g. for header stamping,
    storage bucket selection, or worker queue routing).
    """
    rv = get_residency(tenant_id)
    if rv is None:
        return DEFAULT_REGION
    return rv.region


def set_region(
    tenant_id: str,
    *,
    region: str,
    updated_by: str | None = None,
) -> ResidencyView:
    """Pin ``tenant_id`` to ``region``.

    Raises ``ValueError`` for an empty tenant or an unknown region.
    Caller is responsible for RBAC + MFA gating.
    """
    if not tenant_id:
        raise ValueError("tenant_id is required")
    norm = _normalize(region)
    if norm not in ALLOWED_REGIONS:
        allowed = ", ".join(sorted(ALLOWED_REGIONS))
        raise ValueError(f"region must be one of: {allowed}")
    tid = str(tenant_id)[:64]
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspaceResidency).where(
                WorkspaceResidency.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspaceResidency(
                tenant_id=tid,
                region=norm,
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.region = norm
            row.updated_at = now
            row.updated_by = (str(updated_by)[:128] if updated_by else None)
        s.commit()
        return _to_view(row)


def clear_region(tenant_id: str) -> bool:
    """Drop the tenant residency row. Tenant falls back to
    :data:`DEFAULT_REGION` on the next call. Returns True if a row was
    removed.
    """
    if not tenant_id:
        return False
    tid = str(tenant_id)[:64]
    with session() as s:
        row = s.execute(
            select(WorkspaceResidency).where(
                WorkspaceResidency.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


__all__ = [
    "ALLOWED_REGIONS",
    "DEFAULT_REGION",
    "WorkspaceResidency",
    "ResidencyView",
    "is_allowed",
    "get_residency",
    "get_region",
    "set_region",
    "clear_region",
]
