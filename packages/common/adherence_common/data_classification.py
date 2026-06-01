"""Per-workspace data classification labels.

Enterprise procurement (especially HIPAA covered entities, EU healthcare,
and large fintech buyers) routinely asks: "what data class lives in
this tenant, and how do you prove it?" Procurement teams want to see a
concrete, auditable per-tenant label they can map to their own DLP
policies, encryption rules, and breach-notification playbooks.

Each tenant pins itself to one of :data:`ALLOWED_CLASSIFICATIONS`:

* ``public``        - non-sensitive demo or marketing data
* ``internal``      - business data, no regulatory carve-out
* ``confidential``  - PII / business-sensitive (GDPR Art. 4(1))
* ``restricted``    - PHI / payment data / regulated workloads
                      (HIPAA 45 CFR 164.514, PCI-DSS)

The choice is:

* surfaced on every tenant-bound response as the
  ``X-Data-Classification`` header so callers (and security reviewers
  running curl) can confirm the label without reading docs;
* recorded in the admin audit chain on every change so SOC2 CC6.1 / CC7.2
  reviewers can trace who relabelled a workspace and when;
* tenant-scoped: changing ``acme``'s label never affects ``globex``;
* the single source of truth that downstream systems (PII redactor,
  retention scheduler, webhook egress filter) consult at runtime so
  there cannot be a label-vs-handling drift.

The actual handling (encryption strength, retention floor, egress
filtering) is enforced elsewhere; this module is the contract every
component agrees on.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Column, Integer, String, Text, select
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)


# Labels are deliberately short, stable, lowercase, and audited against
# this set on every write. Adding a label is an explicit code change
# (and a SECURITY.md update) so operators cannot silently introduce
# undeclared sensitivity tiers by typo.
ALLOWED_CLASSIFICATIONS: frozenset[str] = frozenset(
    {"public", "internal", "confidential", "restricted"}
)
DEFAULT_CLASSIFICATION: str = "confidential"

# Minimum retention floors (days) enforced contractually per tier.
# Surfaced via the API so retention UIs can warn before a customer
# tries to set a retention shorter than their declared label allows.
MIN_RETENTION_DAYS: dict[str, int] = {
    "public": 0,
    "internal": 30,
    "confidential": 90,
    "restricted": 365,
}


def _normalize(label: str) -> str:
    return str(label or "").strip().lower()


def is_allowed(label: str) -> bool:
    return _normalize(label) in ALLOWED_CLASSIFICATIONS


class WorkspaceDataClassification(Base):
    """One row per tenant. Absence means the tenant uses
    :data:`DEFAULT_CLASSIFICATION` (``confidential``).
    """

    __tablename__ = "workspace_data_classification"

    tenant_id = Column(String(64), primary_key=True)
    label = Column(String(16), nullable=False)
    justification = Column(Text, nullable=True)
    updated_at = Column(Integer, nullable=False)
    updated_by = Column(String(128), nullable=True)


@dataclass(frozen=True)
class ClassificationView:
    tenant_id: str
    label: str
    justification: Optional[str]
    updated_at: int
    updated_by: Optional[str]


def _now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())


def _to_view(row: WorkspaceDataClassification) -> ClassificationView:
    return ClassificationView(
        tenant_id=str(row.tenant_id),
        label=str(row.label),
        justification=(str(row.justification) if row.justification else None),
        updated_at=int(row.updated_at),
        updated_by=(str(row.updated_by) if row.updated_by else None),
    )


def get_classification(tenant_id: str) -> Optional[ClassificationView]:
    """Return the classification row for ``tenant_id`` or ``None``."""
    if not tenant_id:
        return None
    try:
        with session() as s:
            row = s.execute(
                select(WorkspaceDataClassification).where(
                    WorkspaceDataClassification.tenant_id == str(tenant_id)[:64]
                )
            ).scalar_one_or_none()
            return _to_view(row) if row else None
    except SQLAlchemyError as exc:
        log.warning(
            "classification_get_failed", tenant=tenant_id, error=str(exc)
        )
        return None


def get_label(tenant_id: str) -> str:
    """Return the active label, falling back to
    :data:`DEFAULT_CLASSIFICATION` when unset.

    This is the single function the runtime should consult when it needs
    to decide how to treat a tenant's data.
    """
    cv = get_classification(tenant_id)
    if cv is None:
        return DEFAULT_CLASSIFICATION
    return cv.label


def set_classification(
    tenant_id: str,
    *,
    label: str,
    justification: str | None = None,
    updated_by: str | None = None,
) -> ClassificationView:
    """Pin ``tenant_id`` to ``label``.

    Raises ``ValueError`` for an empty tenant or an unknown label.
    Caller is responsible for RBAC + MFA gating.
    """
    if not tenant_id:
        raise ValueError("tenant_id is required")
    norm = _normalize(label)
    if norm not in ALLOWED_CLASSIFICATIONS:
        allowed = ", ".join(sorted(ALLOWED_CLASSIFICATIONS))
        raise ValueError(f"label must be one of: {allowed}")
    tid = str(tenant_id)[:64]
    just = (str(justification).strip()[:1024] if justification else None) or None
    now = _now_ts()
    with session() as s:
        row = s.execute(
            select(WorkspaceDataClassification).where(
                WorkspaceDataClassification.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            row = WorkspaceDataClassification(
                tenant_id=tid,
                label=norm,
                justification=just,
                updated_at=now,
                updated_by=(str(updated_by)[:128] if updated_by else None),
            )
            s.add(row)
        else:
            row.label = norm
            row.justification = just
            row.updated_at = now
            row.updated_by = (str(updated_by)[:128] if updated_by else None)
        s.commit()
        return _to_view(row)


def clear_classification(tenant_id: str) -> bool:
    """Drop the row. Tenant falls back to :data:`DEFAULT_CLASSIFICATION`.
    Returns True if a row was removed.
    """
    if not tenant_id:
        return False
    tid = str(tenant_id)[:64]
    with session() as s:
        row = s.execute(
            select(WorkspaceDataClassification).where(
                WorkspaceDataClassification.tenant_id == tid
            )
        ).scalar_one_or_none()
        if row is None:
            return False
        s.delete(row)
        s.commit()
        return True


def min_retention_days(label: str) -> int:
    """Return the contractually enforced retention floor for ``label``."""
    return MIN_RETENTION_DAYS.get(_normalize(label), 0)


__all__ = [
    "ALLOWED_CLASSIFICATIONS",
    "DEFAULT_CLASSIFICATION",
    "MIN_RETENTION_DAYS",
    "WorkspaceDataClassification",
    "ClassificationView",
    "is_allowed",
    "get_classification",
    "get_label",
    "set_classification",
    "clear_classification",
    "min_retention_days",
]
