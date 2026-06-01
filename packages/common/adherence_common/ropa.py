"""Per-tenant Record of Processing Activities (RoPA).

GDPR Article 30(2) requires every processor to maintain a written
record of all processing activities carried out on behalf of each
controller. Buyers in regulated industries (especially EU healthcare
and finance) ask to see this register during procurement and during
their own audits. Without an in-product, per-tenant register a
customer cannot satisfy the GDPR Art. 30 evidence requirement using
this service, which is a deal blocker.

Semantics
---------

* A workspace has zero or more RoPA entries. Each entry describes one
  processing activity: its purpose, lawful basis, the categories of
  personal data and data subjects, recipients, retention period,
  international transfers, and technical and organisational measures.
* Entries are mutable but every change is recorded both in the admin
  audit log (via the route layer) and as a monotonic ``version`` on
  the row itself, so a regulator can see how the description has
  evolved.
* Entries can be archived (``archived_at`` set) rather than deleted,
  which preserves the historical record while removing them from the
  active register surfaced to procurement.
* Every read and write is strictly scoped to the caller's tenant. The
  database query helpers below take a ``tenant_id`` and the route
  layer takes it from the authenticated principal. There is no
  cross-tenant code path.

This module follows the same shape as :mod:`adherence_common.legal_hold`
and :mod:`adherence_common.incidents` so the existing audit, retention,
and admin-MFA scaffolding apply without modification.
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

MIN_NAME_LEN = 3
MAX_NAME_LEN = 128
MIN_PURPOSE_LEN = 10
MAX_PURPOSE_LEN = 2048
MAX_BASIS_LEN = 64
MAX_CATEGORIES_LEN = 1024
MAX_SUBJECTS_LEN = 1024
MAX_RECIPIENTS_LEN = 1024
MAX_RETENTION_LEN = 256
MAX_TRANSFERS_LEN = 1024
MAX_MEASURES_LEN = 2048

LAWFUL_BASES = (
    "consent",
    "contract",
    "legal_obligation",
    "vital_interests",
    "public_task",
    "legitimate_interests",
)


class RopaError(ValueError):
    """Raised when a RoPA entry input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise RopaError(f"value too long (max {max_len})")
    return t


def _required(s: str, *, field: str, min_len: int, max_len: int) -> str:
    if s is None:
        raise RopaError(f"{field} is required")
    t = str(s).strip()
    if len(t) < min_len:
        raise RopaError(f"{field} must be at least {min_len} characters")
    if len(t) > max_len:
        raise RopaError(f"{field} must be at most {max_len} characters")
    return t


def _basis(b: str) -> str:
    t = (b or "").strip().lower()
    if t not in LAWFUL_BASES:
        raise RopaError(
            f"lawful_basis must be one of: {', '.join(LAWFUL_BASES)}"
        )
    return t


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class RopaEntry(Base):
    """One processing activity row, scoped to a tenant.

    ``(tenant_id, name)`` is unique among active (non-archived) rows.
    """

    __tablename__ = "ropa_entries"
    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_ropa_tenant_name"),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    name = Column(String(MAX_NAME_LEN), nullable=False)
    purpose = Column(Text, nullable=False)
    lawful_basis = Column(String(MAX_BASIS_LEN), nullable=False)
    data_categories = Column(Text, nullable=True)
    data_subjects = Column(Text, nullable=True)
    recipients = Column(Text, nullable=True)
    retention = Column(String(MAX_RETENTION_LEN), nullable=True)
    transfers = Column(Text, nullable=True)
    security_measures = Column(Text, nullable=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    archived_by = Column(String(128), nullable=True)
    archived_at = Column(DateTime, nullable=True, index=True)


@dataclass(frozen=True)
class RopaView:
    id: int
    tenant_id: str
    name: str
    purpose: str
    lawful_basis: str
    data_categories: Optional[str]
    data_subjects: Optional[str]
    recipients: Optional[str]
    retention: Optional[str]
    transfers: Optional[str]
    security_measures: Optional[str]
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    archived_by: Optional[str]
    archived_at: Optional[str]
    active: bool


def _to_view(row: RopaEntry) -> RopaView:
    return RopaView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        name=str(row.name),
        purpose=str(row.purpose),
        lawful_basis=str(row.lawful_basis),
        data_categories=(str(row.data_categories) if row.data_categories else None),
        data_subjects=(str(row.data_subjects) if row.data_subjects else None),
        recipients=(str(row.recipients) if row.recipients else None),
        retention=(str(row.retention) if row.retention else None),
        transfers=(str(row.transfers) if row.transfers else None),
        security_measures=(str(row.security_measures) if row.security_measures else None),
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
    name: str,
    purpose: str,
    lawful_basis: str,
    created_by: str,
    data_categories: Optional[str] = None,
    data_subjects: Optional[str] = None,
    recipients: Optional[str] = None,
    retention: Optional[str] = None,
    transfers: Optional[str] = None,
    security_measures: Optional[str] = None,
) -> RopaView:
    tid = (tenant_id or "default")[:64]
    cname = _required(name, field="name", min_len=MIN_NAME_LEN, max_len=MAX_NAME_LEN)
    cpurpose = _required(
        purpose, field="purpose", min_len=MIN_PURPOSE_LEN, max_len=MAX_PURPOSE_LEN
    )
    cbasis = _basis(lawful_basis)
    actor = (created_by or "unknown")[:128]
    with session() as s:
        existing = s.execute(
            select(RopaEntry).where(
                RopaEntry.tenant_id == tid,
                RopaEntry.name == cname,
                RopaEntry.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise RopaError(
                f"a RoPA entry named {cname!r} already exists for this workspace"
            )
        row = RopaEntry(
            tenant_id=tid,
            name=cname,
            purpose=cpurpose,
            lawful_basis=cbasis,
            data_categories=_clean(data_categories, max_len=MAX_CATEGORIES_LEN),
            data_subjects=_clean(data_subjects, max_len=MAX_SUBJECTS_LEN),
            recipients=_clean(recipients, max_len=MAX_RECIPIENTS_LEN),
            retention=_clean(retention, max_len=MAX_RETENTION_LEN),
            transfers=_clean(transfers, max_len=MAX_TRANSFERS_LEN),
            security_measures=_clean(security_measures, max_len=MAX_MEASURES_LEN),
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
    purpose: Optional[str] = None,
    lawful_basis: Optional[str] = None,
    data_categories: Optional[str] = None,
    data_subjects: Optional[str] = None,
    recipients: Optional[str] = None,
    retention: Optional[str] = None,
    transfers: Optional[str] = None,
    security_measures: Optional[str] = None,
) -> Optional[RopaView]:
    """Update one entry, strictly scoped to ``tenant_id``.

    Returns None if no active entry with that id exists for the tenant
    (cross-tenant lookup is the multi-tenancy gate). Bumps ``version``
    on every successful change.
    """
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(RopaEntry).where(
                RopaEntry.tenant_id == tid,
                RopaEntry.id == int(entry_id),
                RopaEntry.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if purpose is not None:
            row.purpose = _required(
                purpose,
                field="purpose",
                min_len=MIN_PURPOSE_LEN,
                max_len=MAX_PURPOSE_LEN,
            )
        if lawful_basis is not None:
            row.lawful_basis = _basis(lawful_basis)
        if data_categories is not None:
            row.data_categories = _clean(data_categories, max_len=MAX_CATEGORIES_LEN)
        if data_subjects is not None:
            row.data_subjects = _clean(data_subjects, max_len=MAX_SUBJECTS_LEN)
        if recipients is not None:
            row.recipients = _clean(recipients, max_len=MAX_RECIPIENTS_LEN)
        if retention is not None:
            row.retention = _clean(retention, max_len=MAX_RETENTION_LEN)
        if transfers is not None:
            row.transfers = _clean(transfers, max_len=MAX_TRANSFERS_LEN)
        if security_measures is not None:
            row.security_measures = _clean(security_measures, max_len=MAX_MEASURES_LEN)
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
) -> Optional[RopaView]:
    """Archive one entry, strictly scoped to ``tenant_id``.

    Returns None when no active entry with that id exists for the
    tenant. Idempotent at the caller level: the route layer rejects a
    second archive with HTTP 409.
    """
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(RopaEntry).where(
                RopaEntry.tenant_id == tid,
                RopaEntry.id == int(entry_id),
                RopaEntry.archived_at.is_(None),
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
) -> list[RopaView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(RopaEntry).where(RopaEntry.tenant_id == tid)
        if not include_archived:
            q = q.where(RopaEntry.archived_at.is_(None))
        q = q.order_by(RopaEntry.id.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_entry(*, tenant_id: str, entry_id: int) -> Optional[RopaView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(RopaEntry).where(
                RopaEntry.tenant_id == tid,
                RopaEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def active_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            return int(
                s.execute(
                    select(RopaEntry).where(
                        RopaEntry.tenant_id == tid,
                        RopaEntry.archived_at.is_(None),
                    )
                ).all().__len__()
            )
    except Exception:
        return 0


__all__ = [
    "LAWFUL_BASES",
    "MIN_NAME_LEN",
    "MAX_NAME_LEN",
    "MIN_PURPOSE_LEN",
    "MAX_PURPOSE_LEN",
    "RopaError",
    "RopaEntry",
    "RopaView",
    "create_entry",
    "update_entry",
    "archive_entry",
    "list_entries",
    "get_entry",
    "active_count",
]
