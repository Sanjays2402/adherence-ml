"""Per-tenant Vendor Risk Assessment register.

Procurement and security teams maintain their own vendor risk
register independently of the supplier-published sub-processor list.
SIG, CAIQ, SOC 2 CC9.2, ISO 27001 A.5.19, and HIPAA 164.308(b) all
expect the customer to track who they share data with, what data,
inherent and residual risk, attested certifications, and a periodic
review cadence.

This module is the per-workspace vendor risk register. It is the
tenant's view, not the supplier-published list at
``/v1/subprocessors``: workspaces add their own internal tools,
integration partners, and downstream sub-processors here, and assign
a residual risk and approval status that gates use inside their
organisation.

Semantics
~~~~~~~~~

* A workspace has zero or more vendor rows. Each row carries vendor
  name, vendor type, the data classification shared with that vendor,
  inherent and residual risk tiers, attested certifications,
  evidence URLs, owner, status, and a review cadence.
* ``(tenant_id, vendor_name)`` is unique among active (non-retired)
  rows.
* Reviewing a vendor records the reviewer, an outcome, optional
  notes, and pushes ``next_review_at`` forward by the cadence. The
  full review history lives in :class:`VendorReviewEntry`.
* Retiring a vendor is a soft-delete that preserves the row and its
  review log for audit. Retired rows do not block re-adding the same
  vendor name later.
* Every read and write is strictly scoped to ``tenant_id``. There is
  no cross-tenant code path: cross-tenant lookups return ``None`` and
  cross-tenant mutations are no-ops.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    select,
)

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

MIN_NAME_LEN = 2
MAX_NAME_LEN = 128
MAX_OWNER_LEN = 128
MAX_URL_LEN = 1024
MAX_NOTES_LEN = 4096

VENDOR_TYPES = (
    "subprocessor",
    "integration",
    "internal_tool",
    "infrastructure",
    "consultant",
    "other",
)

DATA_CLASSIFICATIONS = (
    "none",
    "metadata",
    "pii",
    "phi",
    "financial",
    "secrets",
)

RISK_TIERS = ("low", "medium", "high", "critical")

STATUSES = (
    "proposed",
    "approved",
    "conditional",
    "rejected",
    "retired",
)

REVIEW_OUTCOMES = ("approved", "conditional", "rejected", "needs_followup")

DEFAULT_REVIEW_CADENCE_DAYS = 365
MIN_REVIEW_CADENCE_DAYS = 30
MAX_REVIEW_CADENCE_DAYS = 365 * 3


class VendorRiskError(ValueError):
    """Raised when a vendor risk input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise VendorRiskError(f"value too long (max {max_len})")
    return t


def _vendor_name(s: str) -> str:
    if s is None:
        raise VendorRiskError("vendor_name is required")
    t = str(s).strip()
    if len(t) < MIN_NAME_LEN:
        raise VendorRiskError(
            f"vendor_name must be at least {MIN_NAME_LEN} characters"
        )
    if len(t) > MAX_NAME_LEN:
        raise VendorRiskError(
            f"vendor_name must be at most {MAX_NAME_LEN} characters"
        )
    return t


def _enum(value: str, *, allowed: tuple, field: str) -> str:
    t = (value or "").strip().lower()
    if t not in allowed:
        raise VendorRiskError(
            f"{field} must be one of: {', '.join(allowed)}"
        )
    return t


def _url(s: Optional[str]) -> Optional[str]:
    t = _clean(s, max_len=MAX_URL_LEN)
    if t is None:
        return None
    if not (t.startswith("http://") or t.startswith("https://")):
        raise VendorRiskError("evidence_url must start with http:// or https://")
    return t


def _cadence(n: Optional[int]) -> int:
    if n is None:
        return DEFAULT_REVIEW_CADENCE_DAYS
    try:
        v = int(n)
    except (TypeError, ValueError) as exc:
        raise VendorRiskError("review_cadence_days must be an integer") from exc
    if v < MIN_REVIEW_CADENCE_DAYS or v > MAX_REVIEW_CADENCE_DAYS:
        raise VendorRiskError(
            f"review_cadence_days must be between {MIN_REVIEW_CADENCE_DAYS} and "
            f"{MAX_REVIEW_CADENCE_DAYS}"
        )
    return v


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class VendorRiskEntry(Base):
    """One vendor row, scoped to a tenant."""

    __tablename__ = "vendor_risk_entries"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "vendor_name_lc", name="uq_vendor_risk_tenant_name"
        ),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    vendor_name = Column(String(MAX_NAME_LEN), nullable=False)
    # Lowercased copy for the unique index so casing variants collide.
    vendor_name_lc = Column(String(MAX_NAME_LEN), nullable=False)
    vendor_type = Column(String(32), nullable=False)
    data_shared = Column(String(32), nullable=False, default="none")
    inherent_risk = Column(String(16), nullable=False, default="medium")
    residual_risk = Column(String(16), nullable=False, default="medium")
    soc2 = Column(Boolean, nullable=False, default=False)
    iso27001 = Column(Boolean, nullable=False, default=False)
    hipaa = Column(Boolean, nullable=False, default=False)
    pci_dss = Column(Boolean, nullable=False, default=False)
    evidence_url = Column(String(MAX_URL_LEN), nullable=True)
    owner = Column(String(MAX_OWNER_LEN), nullable=False)
    status = Column(String(16), nullable=False, default="proposed")
    notes = Column(Text, nullable=True)
    review_cadence_days = Column(
        Integer, nullable=False, default=DEFAULT_REVIEW_CADENCE_DAYS
    )
    last_reviewed_at = Column(DateTime, nullable=True)
    last_review_outcome = Column(String(32), nullable=True)
    next_review_at = Column(DateTime, nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)
    created_by = Column(String(128), nullable=False)
    created_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    retired_by = Column(String(128), nullable=True)
    retired_at = Column(DateTime, nullable=True, index=True)


class VendorReviewEntry(Base):
    """One review event against a vendor row."""

    __tablename__ = "vendor_risk_reviews"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False)
    vendor_id = Column(
        Integer,
        ForeignKey("vendor_risk_entries.id"),
        nullable=False,
        index=True,
    )
    outcome = Column(String(32), nullable=False)
    notes = Column(Text, nullable=True)
    reviewed_by = Column(String(128), nullable=False)
    reviewed_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )


@dataclass(frozen=True)
class VendorRiskView:
    id: int
    tenant_id: str
    vendor_name: str
    vendor_type: str
    data_shared: str
    inherent_risk: str
    residual_risk: str
    soc2: bool
    iso27001: bool
    hipaa: bool
    pci_dss: bool
    evidence_url: Optional[str]
    owner: str
    status: str
    notes: Optional[str]
    review_cadence_days: int
    last_reviewed_at: Optional[str]
    last_review_outcome: Optional[str]
    next_review_at: str
    review_overdue: bool
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    retired_by: Optional[str]
    retired_at: Optional[str]
    active: bool


@dataclass(frozen=True)
class VendorReviewView:
    id: int
    vendor_id: int
    outcome: str
    notes: Optional[str]
    reviewed_by: str
    reviewed_at: str


def _to_view(row: VendorRiskEntry, *, now: Optional[datetime] = None) -> VendorRiskView:
    n = now or datetime.utcnow()
    overdue = bool(
        row.retired_at is None and row.next_review_at is not None and row.next_review_at < n
    )
    return VendorRiskView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        vendor_name=str(row.vendor_name),
        vendor_type=str(row.vendor_type),
        data_shared=str(row.data_shared),
        inherent_risk=str(row.inherent_risk),
        residual_risk=str(row.residual_risk),
        soc2=bool(row.soc2),
        iso27001=bool(row.iso27001),
        hipaa=bool(row.hipaa),
        pci_dss=bool(row.pci_dss),
        evidence_url=(str(row.evidence_url) if row.evidence_url else None),
        owner=str(row.owner),
        status=str(row.status),
        notes=(str(row.notes) if row.notes else None),
        review_cadence_days=int(row.review_cadence_days),
        last_reviewed_at=(
            row.last_reviewed_at.isoformat() if row.last_reviewed_at else None
        ),
        last_review_outcome=(
            str(row.last_review_outcome) if row.last_review_outcome else None
        ),
        next_review_at=row.next_review_at.isoformat() if row.next_review_at else "",
        review_overdue=overdue,
        version=int(row.version or 1),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=(row.updated_at.isoformat() if row.updated_at else None),
        retired_by=(str(row.retired_by) if row.retired_by else None),
        retired_at=(row.retired_at.isoformat() if row.retired_at else None),
        active=(row.retired_at is None),
    )


def _review_to_view(r: VendorReviewEntry) -> VendorReviewView:
    return VendorReviewView(
        id=int(r.id),
        vendor_id=int(r.vendor_id),
        outcome=str(r.outcome),
        notes=(str(r.notes) if r.notes else None),
        reviewed_by=str(r.reviewed_by),
        reviewed_at=r.reviewed_at.isoformat() if r.reviewed_at else "",
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def create_entry(
    *,
    tenant_id: str,
    vendor_name: str,
    vendor_type: str,
    owner: str,
    created_by: str,
    data_shared: Optional[str] = None,
    inherent_risk: Optional[str] = None,
    residual_risk: Optional[str] = None,
    soc2: bool = False,
    iso27001: bool = False,
    hipaa: bool = False,
    pci_dss: bool = False,
    evidence_url: Optional[str] = None,
    status: Optional[str] = None,
    notes: Optional[str] = None,
    review_cadence_days: Optional[int] = None,
) -> VendorRiskView:
    tid = (tenant_id or "default")[:64]
    name = _vendor_name(vendor_name)
    vtype = _enum(vendor_type, allowed=VENDOR_TYPES, field="vendor_type")
    dclass = _enum(
        data_shared or "none", allowed=DATA_CLASSIFICATIONS, field="data_shared"
    )
    inh = _enum(
        inherent_risk or "medium", allowed=RISK_TIERS, field="inherent_risk"
    )
    res = _enum(
        residual_risk or inh, allowed=RISK_TIERS, field="residual_risk"
    )
    # Residual must not exceed inherent on the ordered tier scale.
    if RISK_TIERS.index(res) > RISK_TIERS.index(inh):
        raise VendorRiskError(
            "residual_risk cannot exceed inherent_risk"
        )
    cstatus = _enum(
        status or "proposed", allowed=STATUSES, field="status"
    )
    if cstatus == "retired":
        raise VendorRiskError(
            "use the retire endpoint to retire a vendor"
        )
    ev = _url(evidence_url)
    cowner = _clean(owner, max_len=MAX_OWNER_LEN)
    if cowner is None:
        raise VendorRiskError("owner is required")
    cnotes = _clean(notes, max_len=MAX_NOTES_LEN)
    cadence = _cadence(review_cadence_days)
    actor = (created_by or "unknown")[:128]
    now = datetime.utcnow()
    next_due = now + timedelta(days=cadence)
    with session() as s:
        existing = s.execute(
            select(VendorRiskEntry).where(
                VendorRiskEntry.tenant_id == tid,
                VendorRiskEntry.vendor_name_lc == name.lower(),
                VendorRiskEntry.retired_at.is_(None),
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise VendorRiskError(
                f"a vendor named {name!r} already exists for this workspace"
            )
        row = VendorRiskEntry(
            tenant_id=tid,
            vendor_name=name,
            vendor_name_lc=name.lower(),
            vendor_type=vtype,
            data_shared=dclass,
            inherent_risk=inh,
            residual_risk=res,
            soc2=bool(soc2),
            iso27001=bool(iso27001),
            hipaa=bool(hipaa),
            pci_dss=bool(pci_dss),
            evidence_url=ev,
            owner=cowner,
            status=cstatus,
            notes=cnotes,
            review_cadence_days=cadence,
            next_review_at=next_due,
            version=1,
            created_by=actor,
            created_at=now,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return _to_view(row)


def update_entry(
    *,
    tenant_id: str,
    entry_id: int,
    updated_by: str,
    vendor_type: Optional[str] = None,
    data_shared: Optional[str] = None,
    inherent_risk: Optional[str] = None,
    residual_risk: Optional[str] = None,
    soc2: Optional[bool] = None,
    iso27001: Optional[bool] = None,
    hipaa: Optional[bool] = None,
    pci_dss: Optional[bool] = None,
    evidence_url: Optional[str] = None,
    owner: Optional[str] = None,
    status: Optional[str] = None,
    notes: Optional[str] = None,
    review_cadence_days: Optional[int] = None,
) -> Optional[VendorRiskView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(VendorRiskEntry).where(
                VendorRiskEntry.tenant_id == tid,
                VendorRiskEntry.id == int(entry_id),
                VendorRiskEntry.retired_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if vendor_type is not None:
            row.vendor_type = _enum(
                vendor_type, allowed=VENDOR_TYPES, field="vendor_type"
            )
        if data_shared is not None:
            row.data_shared = _enum(
                data_shared, allowed=DATA_CLASSIFICATIONS, field="data_shared"
            )
        if inherent_risk is not None:
            row.inherent_risk = _enum(
                inherent_risk, allowed=RISK_TIERS, field="inherent_risk"
            )
        if residual_risk is not None:
            row.residual_risk = _enum(
                residual_risk, allowed=RISK_TIERS, field="residual_risk"
            )
        if RISK_TIERS.index(str(row.residual_risk)) > RISK_TIERS.index(
            str(row.inherent_risk)
        ):
            raise VendorRiskError(
                "residual_risk cannot exceed inherent_risk"
            )
        if soc2 is not None:
            row.soc2 = bool(soc2)
        if iso27001 is not None:
            row.iso27001 = bool(iso27001)
        if hipaa is not None:
            row.hipaa = bool(hipaa)
        if pci_dss is not None:
            row.pci_dss = bool(pci_dss)
        if evidence_url is not None:
            row.evidence_url = _url(evidence_url) if evidence_url else None
        if owner is not None:
            new_owner = _clean(owner, max_len=MAX_OWNER_LEN)
            if new_owner is None:
                raise VendorRiskError("owner cannot be blank")
            row.owner = new_owner
        if status is not None:
            new_status = _enum(status, allowed=STATUSES, field="status")
            if new_status == "retired":
                raise VendorRiskError(
                    "use the retire endpoint to retire a vendor"
                )
            row.status = new_status
        if notes is not None:
            row.notes = _clean(notes, max_len=MAX_NOTES_LEN)
        if review_cadence_days is not None:
            row.review_cadence_days = _cadence(review_cadence_days)
        row.version = int(row.version or 1) + 1
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def record_review(
    *,
    tenant_id: str,
    entry_id: int,
    outcome: str,
    reviewed_by: str,
    notes: Optional[str] = None,
) -> Optional[tuple[VendorRiskView, VendorReviewView]]:
    tid = (tenant_id or "default")[:64]
    out = _enum(outcome, allowed=REVIEW_OUTCOMES, field="outcome")
    cnotes = _clean(notes, max_len=MAX_NOTES_LEN)
    actor = (reviewed_by or "unknown")[:128]
    now = datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(VendorRiskEntry).where(
                VendorRiskEntry.tenant_id == tid,
                VendorRiskEntry.id == int(entry_id),
                VendorRiskEntry.retired_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        review = VendorReviewEntry(
            tenant_id=tid,
            vendor_id=int(row.id),
            outcome=out,
            notes=cnotes,
            reviewed_by=actor,
            reviewed_at=now,
        )
        s.add(review)
        row.last_reviewed_at = now
        row.last_review_outcome = out
        row.next_review_at = now + timedelta(days=int(row.review_cadence_days))
        # Reflect the outcome in the row status when decisive.
        if out == "approved":
            row.status = "approved"
        elif out == "conditional":
            row.status = "conditional"
        elif out == "rejected":
            row.status = "rejected"
        row.version = int(row.version or 1) + 1
        row.updated_by = actor
        row.updated_at = now
        s.commit()
        s.refresh(row)
        s.refresh(review)
        return _to_view(row), _review_to_view(review)


def retire_entry(
    *,
    tenant_id: str,
    entry_id: int,
    retired_by: str,
) -> Optional[VendorRiskView]:
    tid = (tenant_id or "default")[:64]
    actor = (retired_by or "unknown")[:128]
    with session() as s:
        row = s.execute(
            select(VendorRiskEntry).where(
                VendorRiskEntry.tenant_id == tid,
                VendorRiskEntry.id == int(entry_id),
                VendorRiskEntry.retired_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.retired_by = actor
        row.retired_at = datetime.utcnow()
        row.status = "retired"
        s.commit()
        s.refresh(row)
        return _to_view(row)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def list_entries(
    *,
    tenant_id: str,
    include_retired: bool = False,
    limit: int = 200,
    offset: int = 0,
) -> list[VendorRiskView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(VendorRiskEntry).where(VendorRiskEntry.tenant_id == tid)
        if not include_retired:
            q = q.where(VendorRiskEntry.retired_at.is_(None))
        q = q.order_by(VendorRiskEntry.id.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_entry(*, tenant_id: str, entry_id: int) -> Optional[VendorRiskView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(VendorRiskEntry).where(
                VendorRiskEntry.tenant_id == tid,
                VendorRiskEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def list_reviews(
    *, tenant_id: str, entry_id: int, limit: int = 100
) -> list[VendorReviewView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        # Enforce tenant scope by confirming the parent vendor belongs to the tenant.
        parent = s.execute(
            select(VendorRiskEntry).where(
                VendorRiskEntry.tenant_id == tid,
                VendorRiskEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        if parent is None:
            return []
        q = (
            select(VendorReviewEntry)
            .where(
                VendorReviewEntry.tenant_id == tid,
                VendorReviewEntry.vendor_id == int(entry_id),
            )
            .order_by(VendorReviewEntry.id.desc())
            .limit(int(limit))
        )
        return [_review_to_view(r) for r in s.execute(q).scalars().all()]


def summary(*, tenant_id: str) -> dict:
    tid = (tenant_id or "default")[:64]
    now = datetime.utcnow()
    with session() as s:
        rows = s.execute(
            select(VendorRiskEntry).where(VendorRiskEntry.tenant_id == tid)
        ).scalars().all()
    active = [r for r in rows if r.retired_at is None]
    overdue = [
        r for r in active if r.next_review_at is not None and r.next_review_at < now
    ]
    by_status: dict[str, int] = {s_: 0 for s_ in STATUSES}
    by_risk: dict[str, int] = {t: 0 for t in RISK_TIERS}
    for r in active:
        by_status[str(r.status)] = by_status.get(str(r.status), 0) + 1
        by_risk[str(r.residual_risk)] = by_risk.get(str(r.residual_risk), 0) + 1
    return {
        "tenant_id": tid,
        "total": len(rows),
        "active": len(active),
        "retired": len(rows) - len(active),
        "overdue": len(overdue),
        "by_status": by_status,
        "by_residual_risk": by_risk,
    }


__all__ = [
    "VENDOR_TYPES",
    "DATA_CLASSIFICATIONS",
    "RISK_TIERS",
    "STATUSES",
    "REVIEW_OUTCOMES",
    "MIN_NAME_LEN",
    "MAX_NAME_LEN",
    "MAX_OWNER_LEN",
    "MAX_URL_LEN",
    "MAX_NOTES_LEN",
    "DEFAULT_REVIEW_CADENCE_DAYS",
    "MIN_REVIEW_CADENCE_DAYS",
    "MAX_REVIEW_CADENCE_DAYS",
    "VendorRiskError",
    "VendorRiskEntry",
    "VendorReviewEntry",
    "VendorRiskView",
    "VendorReviewView",
    "create_entry",
    "update_entry",
    "record_review",
    "retire_entry",
    "list_entries",
    "get_entry",
    "list_reviews",
    "summary",
]
