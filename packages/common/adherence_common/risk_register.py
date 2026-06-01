"""Per-tenant Enterprise Risk Register.

ISO 31000 / COSO ERM / SOC 2 CC3.2 / NIST RMF all require an
organisation to maintain a *forward-looking* register of risks that
could affect its objectives, with documented likelihood, impact,
mitigations, residual posture, owner, and a periodic review cadence.

Buyers in regulated industries routinely ask their vendors to share
the register relevant to the service they are about to procure. The
existing incident register (:mod:`adherence_common.incidents`) covers
events that have already happened; the DPIA register
(:mod:`adherence_common.dpia`) covers privacy specifically. Neither
satisfies the generic enterprise risk register requirement.

Semantics
~~~~~~~~~

* A workspace has zero or more risk entries. Each entry describes one
  risk: title, category, narrative description, the affected
  asset/system, likelihood (1..5), impact (1..5), mitigations in
  place, residual likelihood and impact after those mitigations, the
  treatment decision (accept | mitigate | transfer | avoid), an
  owner, the date the risk was identified, and the date of the next
  scheduled review.
* The inherent and residual scores are computed server-side from the
  1..5 grids (product, range 1..25). Clients cannot lie about the
  score.
* Entries are mutable; every change bumps a monotonic ``version``
  and updates ``updated_at``/``updated_by``. The route layer mirrors
  every change into the admin audit log.
* Entries can be closed (``closed_at`` set) rather than deleted to
  preserve the historical record while removing the row from the
  active register surfaced to procurement.
* Every read and write is strictly scoped to the caller's tenant.
  Cross-tenant lookups return ``None``; cross-tenant mutations are
  no-ops. There is no cross-tenant code path in this module.

This module mirrors :mod:`adherence_common.ropa` and
:mod:`adherence_common.dpia` so the existing admin-audit, retention,
dry-run, and admin-MFA scaffolding apply without modification.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, select

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

MIN_TITLE_LEN = 3
MAX_TITLE_LEN = 128
MIN_DESC_LEN = 10
MAX_DESC_LEN = 4096
MAX_CATEGORY_LEN = 64
MAX_ASSET_LEN = 256
MAX_OWNER_LEN = 128
MAX_MITIGATIONS_LEN = 4096
MAX_NOTES_LEN = 2048
MAX_STATUS_LEN = 32

CATEGORIES = (
    "security",
    "privacy",
    "availability",
    "integrity",
    "confidentiality",
    "compliance",
    "operational",
    "financial",
    "vendor",
    "model",
    "other",
)

TREATMENTS = ("accept", "mitigate", "transfer", "avoid")

STATUSES = ("open", "mitigating", "accepted", "monitoring", "closed")

# Score grid is a square 1..5 matrix per ISO 31000 examples.
SCORE_MIN = 1
SCORE_MAX = 5


class RiskRegisterError(ValueError):
    """Raised when a risk register input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise RiskRegisterError(f"value too long (max {max_len})")
    return t


def _required(s: str, *, field: str, min_len: int, max_len: int) -> str:
    if s is None:
        raise RiskRegisterError(f"{field} is required")
    t = str(s).strip()
    if len(t) < min_len:
        raise RiskRegisterError(f"{field} must be at least {min_len} characters")
    if len(t) > max_len:
        raise RiskRegisterError(f"{field} must be at most {max_len} characters")
    return t


def _category(c: str) -> str:
    t = (c or "").strip().lower()
    if t not in CATEGORIES:
        raise RiskRegisterError(
            f"category must be one of: {', '.join(CATEGORIES)}"
        )
    return t


def _treatment(t: str) -> str:
    v = (t or "").strip().lower()
    if v not in TREATMENTS:
        raise RiskRegisterError(
            f"treatment must be one of: {', '.join(TREATMENTS)}"
        )
    return v


def _status(s: str) -> str:
    v = (s or "").strip().lower()
    if v not in STATUSES:
        raise RiskRegisterError(
            f"status must be one of: {', '.join(STATUSES)}"
        )
    return v


def _score(n: int, *, field: str) -> int:
    try:
        v = int(n)
    except (TypeError, ValueError) as exc:
        raise RiskRegisterError(f"{field} must be an integer 1..5") from exc
    if v < SCORE_MIN or v > SCORE_MAX:
        raise RiskRegisterError(f"{field} must be between 1 and 5")
    return v


def _iso_date(s: Optional[str], *, field: str) -> Optional[datetime]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    # Accept either YYYY-MM-DD or full ISO-8601.
    try:
        if len(t) == 10:
            return datetime.strptime(t, "%Y-%m-%d")
        return datetime.fromisoformat(t.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError as exc:
        raise RiskRegisterError(f"{field} must be ISO-8601 (YYYY-MM-DD or full)") from exc


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class RiskEntry(Base):
    """One enterprise risk row, scoped to a tenant.

    ``(tenant_id, title)`` is unique among active (non-closed) rows.
    """

    __tablename__ = "risk_register_entries"
    __table_args__ = (
        UniqueConstraint("tenant_id", "title", name="uq_risk_tenant_title"),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    title = Column(String(MAX_TITLE_LEN), nullable=False)
    category = Column(String(MAX_CATEGORY_LEN), nullable=False)
    description = Column(Text, nullable=False)
    asset = Column(String(MAX_ASSET_LEN), nullable=True)
    likelihood = Column(Integer, nullable=False)
    impact = Column(Integer, nullable=False)
    mitigations = Column(Text, nullable=True)
    residual_likelihood = Column(Integer, nullable=False)
    residual_impact = Column(Integer, nullable=False)
    treatment = Column(String(16), nullable=False)
    owner = Column(String(MAX_OWNER_LEN), nullable=False)
    status = Column(String(MAX_STATUS_LEN), nullable=False, default="open")
    identified_at = Column(DateTime, nullable=False)
    next_review_at = Column(DateTime, nullable=True, index=True)
    notes = Column(Text, nullable=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    closed_by = Column(String(128), nullable=True)
    closed_at = Column(DateTime, nullable=True, index=True)
    closed_reason = Column(String(256), nullable=True)


@dataclass(frozen=True)
class RiskView:
    id: int
    tenant_id: str
    title: str
    category: str
    description: str
    asset: Optional[str]
    likelihood: int
    impact: int
    inherent_score: int
    mitigations: Optional[str]
    residual_likelihood: int
    residual_impact: int
    residual_score: int
    treatment: str
    owner: str
    status: str
    identified_at: str
    next_review_at: Optional[str]
    notes: Optional[str]
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    closed_by: Optional[str]
    closed_at: Optional[str]
    closed_reason: Optional[str]
    active: bool
    review_overdue: bool


def _to_view(row: RiskEntry, *, now: Optional[datetime] = None) -> RiskView:
    n = now or datetime.utcnow()
    next_due = row.next_review_at
    overdue = bool(
        row.closed_at is None
        and next_due is not None
        and next_due < n
    )
    return RiskView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        title=str(row.title),
        category=str(row.category),
        description=str(row.description),
        asset=(str(row.asset) if row.asset else None),
        likelihood=int(row.likelihood),
        impact=int(row.impact),
        inherent_score=int(row.likelihood) * int(row.impact),
        mitigations=(str(row.mitigations) if row.mitigations else None),
        residual_likelihood=int(row.residual_likelihood),
        residual_impact=int(row.residual_impact),
        residual_score=int(row.residual_likelihood) * int(row.residual_impact),
        treatment=str(row.treatment),
        owner=str(row.owner),
        status=str(row.status or "open"),
        identified_at=row.identified_at.isoformat() if row.identified_at else "",
        next_review_at=(row.next_review_at.isoformat() if row.next_review_at else None),
        notes=(str(row.notes) if row.notes else None),
        version=int(row.version or 1),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=(row.updated_at.isoformat() if row.updated_at else None),
        closed_by=(str(row.closed_by) if row.closed_by else None),
        closed_at=(row.closed_at.isoformat() if row.closed_at else None),
        closed_reason=(str(row.closed_reason) if row.closed_reason else None),
        active=(row.closed_at is None),
        review_overdue=overdue,
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def create_entry(
    *,
    tenant_id: str,
    title: str,
    category: str,
    description: str,
    likelihood: int,
    impact: int,
    treatment: str,
    owner: str,
    created_by: str,
    asset: Optional[str] = None,
    mitigations: Optional[str] = None,
    residual_likelihood: Optional[int] = None,
    residual_impact: Optional[int] = None,
    status: Optional[str] = None,
    identified_at: Optional[str] = None,
    next_review_at: Optional[str] = None,
    notes: Optional[str] = None,
) -> RiskView:
    tid = (tenant_id or "default")[:64]
    ctitle = _required(title, field="title", min_len=MIN_TITLE_LEN, max_len=MAX_TITLE_LEN)
    cdesc = _required(description, field="description", min_len=MIN_DESC_LEN, max_len=MAX_DESC_LEN)
    ccat = _category(category)
    ctreat = _treatment(treatment)
    cstatus = _status(status) if status is not None else "open"
    clike = _score(likelihood, field="likelihood")
    cimpact = _score(impact, field="impact")
    rl = _score(
        residual_likelihood if residual_likelihood is not None else clike,
        field="residual_likelihood",
    )
    ri = _score(
        residual_impact if residual_impact is not None else cimpact,
        field="residual_impact",
    )
    if rl > clike:
        raise RiskRegisterError("residual_likelihood cannot exceed inherent likelihood")
    if ri > cimpact:
        raise RiskRegisterError("residual_impact cannot exceed inherent impact")
    cowner = _required(owner, field="owner", min_len=1, max_len=MAX_OWNER_LEN)
    cmit = _clean(mitigations, max_len=MAX_MITIGATIONS_LEN)
    casset = _clean(asset, max_len=MAX_ASSET_LEN)
    cnotes = _clean(notes, max_len=MAX_NOTES_LEN)
    cid = _iso_date(identified_at, field="identified_at") or datetime.utcnow()
    cnext = _iso_date(next_review_at, field="next_review_at")
    actor = (created_by or "unknown")[:128]
    with session() as s:
        existing = s.execute(
            select(RiskEntry).where(
                RiskEntry.tenant_id == tid,
                RiskEntry.title == ctitle,
                RiskEntry.closed_at.is_(None),
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise RiskRegisterError(
                f"a risk entry titled {ctitle!r} already exists for this workspace"
            )
        row = RiskEntry(
            tenant_id=tid,
            title=ctitle,
            category=ccat,
            description=cdesc,
            asset=casset,
            likelihood=clike,
            impact=cimpact,
            mitigations=cmit,
            residual_likelihood=rl,
            residual_impact=ri,
            treatment=ctreat,
            owner=cowner,
            status=cstatus,
            identified_at=cid,
            next_review_at=cnext,
            notes=cnotes,
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
    title: Optional[str] = None,
    category: Optional[str] = None,
    description: Optional[str] = None,
    asset: Optional[str] = None,
    likelihood: Optional[int] = None,
    impact: Optional[int] = None,
    mitigations: Optional[str] = None,
    residual_likelihood: Optional[int] = None,
    residual_impact: Optional[int] = None,
    treatment: Optional[str] = None,
    owner: Optional[str] = None,
    status: Optional[str] = None,
    identified_at: Optional[str] = None,
    next_review_at: Optional[str] = None,
    notes: Optional[str] = None,
) -> Optional[RiskView]:
    """Update one entry, strictly scoped to ``tenant_id``.

    Returns None if no active entry with that id exists for the tenant
    (cross-tenant lookup is the multi-tenancy gate). Bumps ``version``
    on every successful change.
    """
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(RiskEntry).where(
                RiskEntry.tenant_id == tid,
                RiskEntry.id == int(entry_id),
                RiskEntry.closed_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if title is not None:
            new_title = _required(
                title, field="title", min_len=MIN_TITLE_LEN, max_len=MAX_TITLE_LEN
            )
            if new_title != row.title:
                clash = s.execute(
                    select(RiskEntry).where(
                        RiskEntry.tenant_id == tid,
                        RiskEntry.title == new_title,
                        RiskEntry.closed_at.is_(None),
                        RiskEntry.id != row.id,
                    )
                ).scalar_one_or_none()
                if clash is not None:
                    raise RiskRegisterError(
                        f"a risk entry titled {new_title!r} already exists"
                    )
                row.title = new_title
        if category is not None:
            row.category = _category(category)
        if description is not None:
            row.description = _required(
                description, field="description", min_len=MIN_DESC_LEN, max_len=MAX_DESC_LEN
            )
        if asset is not None:
            row.asset = _clean(asset, max_len=MAX_ASSET_LEN)
        if likelihood is not None:
            row.likelihood = _score(likelihood, field="likelihood")
        if impact is not None:
            row.impact = _score(impact, field="impact")
        if mitigations is not None:
            row.mitigations = _clean(mitigations, max_len=MAX_MITIGATIONS_LEN)
        if residual_likelihood is not None:
            row.residual_likelihood = _score(
                residual_likelihood, field="residual_likelihood"
            )
        if residual_impact is not None:
            row.residual_impact = _score(residual_impact, field="residual_impact")
        if int(row.residual_likelihood) > int(row.likelihood):
            raise RiskRegisterError(
                "residual_likelihood cannot exceed inherent likelihood"
            )
        if int(row.residual_impact) > int(row.impact):
            raise RiskRegisterError(
                "residual_impact cannot exceed inherent impact"
            )
        if treatment is not None:
            row.treatment = _treatment(treatment)
        if owner is not None:
            row.owner = _required(
                owner, field="owner", min_len=1, max_len=MAX_OWNER_LEN
            )
        if status is not None:
            new_status = _status(status)
            if new_status == "closed":
                raise RiskRegisterError(
                    "use the close endpoint to close a risk"
                )
            row.status = new_status
        if identified_at is not None:
            d = _iso_date(identified_at, field="identified_at")
            if d is not None:
                row.identified_at = d
        if next_review_at is not None:
            row.next_review_at = _iso_date(next_review_at, field="next_review_at")
        if notes is not None:
            row.notes = _clean(notes, max_len=MAX_NOTES_LEN)
        row.version = int(row.version or 1) + 1
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def close_entry(
    *,
    tenant_id: str,
    entry_id: int,
    closed_by: str,
    reason: Optional[str] = None,
) -> Optional[RiskView]:
    """Close one entry, strictly scoped to ``tenant_id``.

    Returns None when no active entry with that id exists for the
    tenant. Idempotent at the caller level: the route layer rejects a
    second close with HTTP 409.
    """
    tid = (tenant_id or "default")[:64]
    creason = _clean(reason, max_len=256)
    with session() as s:
        row = s.execute(
            select(RiskEntry).where(
                RiskEntry.tenant_id == tid,
                RiskEntry.id == int(entry_id),
                RiskEntry.closed_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.closed_by = (closed_by or "unknown")[:128]
        row.closed_at = datetime.utcnow()
        row.status = "closed"
        if creason is not None:
            row.closed_reason = creason
        s.commit()
        s.refresh(row)
        return _to_view(row)


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def list_entries(
    *,
    tenant_id: str,
    include_closed: bool = False,
    category: Optional[str] = None,
    limit: int = 200,
    offset: int = 0,
) -> list[RiskView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(RiskEntry).where(RiskEntry.tenant_id == tid)
        if not include_closed:
            q = q.where(RiskEntry.closed_at.is_(None))
        if category:
            try:
                q = q.where(RiskEntry.category == _category(category))
            except RiskRegisterError:
                return []
        q = q.order_by(RiskEntry.id.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_entry(*, tenant_id: str, entry_id: int) -> Optional[RiskView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(RiskEntry).where(
                RiskEntry.tenant_id == tid,
                RiskEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def active_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            return int(
                s.execute(
                    select(RiskEntry).where(
                        RiskEntry.tenant_id == tid,
                        RiskEntry.closed_at.is_(None),
                    )
                ).all().__len__()
            )
    except Exception:
        return 0


def overdue_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    now = datetime.utcnow()
    try:
        with session() as s:
            rows = s.execute(
                select(RiskEntry).where(
                    RiskEntry.tenant_id == tid,
                    RiskEntry.closed_at.is_(None),
                    RiskEntry.next_review_at.is_not(None),
                    RiskEntry.next_review_at < now,
                )
            ).scalars().all()
            return len(rows)
    except Exception:
        return 0


__all__ = [
    "CATEGORIES",
    "TREATMENTS",
    "STATUSES",
    "SCORE_MIN",
    "SCORE_MAX",
    "MIN_TITLE_LEN",
    "MAX_TITLE_LEN",
    "MIN_DESC_LEN",
    "MAX_DESC_LEN",
    "MAX_CATEGORY_LEN",
    "MAX_ASSET_LEN",
    "MAX_OWNER_LEN",
    "MAX_MITIGATIONS_LEN",
    "MAX_NOTES_LEN",
    "MAX_STATUS_LEN",
    "RiskRegisterError",
    "RiskEntry",
    "RiskView",
    "create_entry",
    "update_entry",
    "close_entry",
    "list_entries",
    "get_entry",
    "active_count",
    "overdue_count",
]
