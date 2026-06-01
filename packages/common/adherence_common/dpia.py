"""Per-tenant Data Protection Impact Assessment (DPIA) register.

GDPR Article 35 requires the controller to carry out a DPIA prior to
any processing that is likely to result in a high risk to the rights
and freedoms of natural persons. Processing health data (which an
adherence prediction service does by construction) is on every
supervisory authority's "must DPIA" list, so a customer in a regulated
sector cannot use this service in production without a DPIA on file
for each high-risk activity.

This module is the per-workspace register of those assessments. It
sits next to the GDPR Art. 30 RoPA register and the Art. 33 incident
register so a workspace owner can hand a regulator a complete evidence
pack without leaving the product.

Semantics
---------

* A workspace has zero or more DPIA entries. Each entry describes one
  high-risk processing activity: a short title, a description, the
  necessity and proportionality assessment, identified risks to data
  subjects, mitigations, residual risk rating, whether the DPO was
  consulted, whether a prior supervisory authority consultation under
  Art. 36 is required, and when the assessment is next due for review.
* Entries are mutable; every change bumps a monotonic ``version`` and
  the route layer writes an admin audit row.
* Entries can be archived rather than deleted, preserving the
  historical record for the regulator.
* Every read and write is strictly scoped to the caller's tenant. There
  is no cross-tenant code path: ``tenant_id`` is part of every query.

This module mirrors :mod:`adherence_common.ropa` so the existing audit,
retention, and admin-MFA scaffolding apply without modification.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, select

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

MIN_TITLE_LEN = 3
MAX_TITLE_LEN = 128
MIN_DESCRIPTION_LEN = 10
MAX_DESCRIPTION_LEN = 4096
MAX_NECESSITY_LEN = 4096
MAX_RISKS_LEN = 4096
MAX_MITIGATIONS_LEN = 4096

RISK_RATINGS = ("low", "moderate", "high")

# A DPIA review cadence. ICO and EDPB guidance is "at least every three
# years or whenever processing changes". Default is one year so that
# the customer is reminded well inside any regulator's expectation.
DEFAULT_REVIEW_DAYS = 365
MIN_REVIEW_DAYS = 30
MAX_REVIEW_DAYS = 365 * 3


class DpiaError(ValueError):
    """Raised when a DPIA entry input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise DpiaError(f"value too long (max {max_len})")
    return t


def _required(s: str, *, field: str, min_len: int, max_len: int) -> str:
    if s is None:
        raise DpiaError(f"{field} is required")
    t = str(s).strip()
    if len(t) < min_len:
        raise DpiaError(f"{field} must be at least {min_len} characters")
    if len(t) > max_len:
        raise DpiaError(f"{field} must be at most {max_len} characters")
    return t


def _rating(r: str) -> str:
    t = (r or "").strip().lower()
    if t not in RISK_RATINGS:
        raise DpiaError(
            f"residual_risk must be one of: {', '.join(RISK_RATINGS)}"
        )
    return t


def _review_days(n: Optional[int]) -> int:
    if n is None:
        return DEFAULT_REVIEW_DAYS
    try:
        v = int(n)
    except (TypeError, ValueError) as exc:
        raise DpiaError("review_in_days must be an integer") from exc
    if v < MIN_REVIEW_DAYS or v > MAX_REVIEW_DAYS:
        raise DpiaError(
            f"review_in_days must be between {MIN_REVIEW_DAYS} and {MAX_REVIEW_DAYS}"
        )
    return v


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class DpiaEntry(Base):
    """One DPIA row, scoped to a tenant.

    ``(tenant_id, title)`` is unique among active (non-archived) rows.
    """

    __tablename__ = "dpia_entries"
    __table_args__ = (
        UniqueConstraint("tenant_id", "title", name="uq_dpia_tenant_title"),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    title = Column(String(MAX_TITLE_LEN), nullable=False)
    description = Column(Text, nullable=False)
    necessity = Column(Text, nullable=True)
    risks = Column(Text, nullable=True)
    mitigations = Column(Text, nullable=True)
    residual_risk = Column(String(16), nullable=False, default="moderate")
    dpo_consulted = Column(Integer, nullable=False, default=0)  # 0/1
    consultation_required = Column(Integer, nullable=False, default=0)  # 0/1
    review_due_at = Column(DateTime, nullable=False, index=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    archived_by = Column(String(128), nullable=True)
    archived_at = Column(DateTime, nullable=True, index=True)


@dataclass(frozen=True)
class DpiaView:
    id: int
    tenant_id: str
    title: str
    description: str
    necessity: Optional[str]
    risks: Optional[str]
    mitigations: Optional[str]
    residual_risk: str
    dpo_consulted: bool
    consultation_required: bool
    review_due_at: str
    review_overdue: bool
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    archived_by: Optional[str]
    archived_at: Optional[str]
    active: bool


def _to_view(row: DpiaEntry, *, now: Optional[datetime] = None) -> DpiaView:
    n = now or datetime.utcnow()
    review = row.review_due_at or n
    overdue = bool(row.archived_at is None and review < n)
    return DpiaView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        title=str(row.title),
        description=str(row.description),
        necessity=(str(row.necessity) if row.necessity else None),
        risks=(str(row.risks) if row.risks else None),
        mitigations=(str(row.mitigations) if row.mitigations else None),
        residual_risk=str(row.residual_risk or "moderate"),
        dpo_consulted=bool(int(row.dpo_consulted or 0)),
        consultation_required=bool(int(row.consultation_required or 0)),
        review_due_at=review.isoformat(),
        review_overdue=overdue,
        version=int(row.version or 1),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=(row.updated_at.isoformat() if row.updated_at else None),
        archived_by=(str(row.archived_by) if row.archived_by else None),
        archived_at=(row.archived_at.isoformat() if row.archived_at else None),
        active=(row.archived_at is None),
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def create_entry(
    *,
    tenant_id: str,
    title: str,
    description: str,
    residual_risk: str,
    created_by: str,
    necessity: Optional[str] = None,
    risks: Optional[str] = None,
    mitigations: Optional[str] = None,
    dpo_consulted: bool = False,
    consultation_required: bool = False,
    review_in_days: Optional[int] = None,
) -> DpiaView:
    tid = (tenant_id or "default")[:64]
    ctitle = _required(title, field="title", min_len=MIN_TITLE_LEN, max_len=MAX_TITLE_LEN)
    cdesc = _required(
        description,
        field="description",
        min_len=MIN_DESCRIPTION_LEN,
        max_len=MAX_DESCRIPTION_LEN,
    )
    crisk = _rating(residual_risk)
    days = _review_days(review_in_days)
    actor = (created_by or "unknown")[:128]
    with session() as s:
        existing = s.execute(
            select(DpiaEntry).where(
                DpiaEntry.tenant_id == tid,
                DpiaEntry.title == ctitle,
                DpiaEntry.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise DpiaError(
                f"a DPIA entry titled {ctitle!r} already exists for this workspace"
            )
        row = DpiaEntry(
            tenant_id=tid,
            title=ctitle,
            description=cdesc,
            necessity=_clean(necessity, max_len=MAX_NECESSITY_LEN),
            risks=_clean(risks, max_len=MAX_RISKS_LEN),
            mitigations=_clean(mitigations, max_len=MAX_MITIGATIONS_LEN),
            residual_risk=crisk,
            dpo_consulted=(1 if dpo_consulted else 0),
            consultation_required=(1 if consultation_required else 0),
            review_due_at=datetime.utcnow() + timedelta(days=days),
            version=1,
            created_by=actor,
            created_at=datetime.utcnow(),
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
    description: Optional[str] = None,
    necessity: Optional[str] = None,
    risks: Optional[str] = None,
    mitigations: Optional[str] = None,
    residual_risk: Optional[str] = None,
    dpo_consulted: Optional[bool] = None,
    consultation_required: Optional[bool] = None,
    review_in_days: Optional[int] = None,
) -> Optional[DpiaView]:
    """Update one entry, strictly scoped to ``tenant_id``.

    Returns ``None`` if no active entry with that id exists for the
    tenant. The tenant scope on the query is the multi-tenancy gate.
    Every successful change bumps ``version``.
    """
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(DpiaEntry).where(
                DpiaEntry.tenant_id == tid,
                DpiaEntry.id == int(entry_id),
                DpiaEntry.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if description is not None:
            row.description = _required(
                description,
                field="description",
                min_len=MIN_DESCRIPTION_LEN,
                max_len=MAX_DESCRIPTION_LEN,
            )
        if necessity is not None:
            row.necessity = _clean(necessity, max_len=MAX_NECESSITY_LEN)
        if risks is not None:
            row.risks = _clean(risks, max_len=MAX_RISKS_LEN)
        if mitigations is not None:
            row.mitigations = _clean(mitigations, max_len=MAX_MITIGATIONS_LEN)
        if residual_risk is not None:
            row.residual_risk = _rating(residual_risk)
        if dpo_consulted is not None:
            row.dpo_consulted = 1 if dpo_consulted else 0
        if consultation_required is not None:
            row.consultation_required = 1 if consultation_required else 0
        if review_in_days is not None:
            days = _review_days(review_in_days)
            row.review_due_at = datetime.utcnow() + timedelta(days=days)
        row.version = int(row.version or 1) + 1
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def archive_entry(
    *,
    tenant_id: str,
    entry_id: int,
    archived_by: str,
) -> Optional[DpiaView]:
    """Archive one entry, strictly scoped to ``tenant_id``.

    Returns ``None`` when no active entry with that id exists for the
    tenant.
    """
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(DpiaEntry).where(
                DpiaEntry.tenant_id == tid,
                DpiaEntry.id == int(entry_id),
                DpiaEntry.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.archived_by = (archived_by or "unknown")[:128]
        row.archived_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def list_entries(
    *,
    tenant_id: str,
    include_archived: bool = False,
    limit: int = 200,
    offset: int = 0,
) -> list[DpiaView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(DpiaEntry).where(DpiaEntry.tenant_id == tid)
        if not include_archived:
            q = q.where(DpiaEntry.archived_at.is_(None))
        q = q.order_by(DpiaEntry.id.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_entry(*, tenant_id: str, entry_id: int) -> Optional[DpiaView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(DpiaEntry).where(
                DpiaEntry.tenant_id == tid,
                DpiaEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def active_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            return len(
                s.execute(
                    select(DpiaEntry).where(
                        DpiaEntry.tenant_id == tid,
                        DpiaEntry.archived_at.is_(None),
                    )
                ).all()
            )
    except Exception:
        return 0


def overdue_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    now = datetime.utcnow()
    try:
        with session() as s:
            return len(
                s.execute(
                    select(DpiaEntry).where(
                        DpiaEntry.tenant_id == tid,
                        DpiaEntry.archived_at.is_(None),
                        DpiaEntry.review_due_at < now,
                    )
                ).all()
            )
    except Exception:
        return 0


__all__ = [
    "RISK_RATINGS",
    "DEFAULT_REVIEW_DAYS",
    "MIN_REVIEW_DAYS",
    "MAX_REVIEW_DAYS",
    "MIN_TITLE_LEN",
    "MAX_TITLE_LEN",
    "MIN_DESCRIPTION_LEN",
    "MAX_DESCRIPTION_LEN",
    "MAX_NECESSITY_LEN",
    "MAX_RISKS_LEN",
    "MAX_MITIGATIONS_LEN",
    "DpiaError",
    "DpiaEntry",
    "DpiaView",
    "create_entry",
    "update_entry",
    "archive_entry",
    "list_entries",
    "get_entry",
    "active_count",
    "overdue_count",
]
