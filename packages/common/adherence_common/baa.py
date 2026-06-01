"""Per-tenant HIPAA Business Associate Agreement (BAA) register.

A medication adherence service handles Protected Health Information by
construction. Under 45 CFR 164.502(e) and 164.504(e), a HIPAA covered
entity cannot lawfully disclose PHI to a business associate without a
signed BAA in force. Procurement at any U.S. health system, payer, or
pharmacy chain blocks adoption until the buyer can hand its compliance
office evidence that a BAA exists, names the right counterparty,
covers the in-scope services, and is currently in effect.

This module is the per-workspace register of those agreements. It
sits alongside the GDPR Art. 30 RoPA register and the Art. 35 DPIA
register so a workspace owner can hand a compliance reviewer a single
evidence pack.

Semantics
---------

* A workspace has zero or more BAA entries. Each entry names a
  counterparty, the version of the executed document, effective and
  expiry dates, the agreed breach-notification SLA in hours, optional
  signatory names, and an optional evidence URL pointing at the
  customer's contracts vault. PHI itself is never stored here; this
  is the contractual shell only.
* Entries can be ``draft`` (not yet executed), ``active`` (executed,
  in date window), ``expired`` (executed, past expiry), or
  ``terminated`` (deliberately ended before expiry).
* ``effective_status`` is derived from the stored ``status`` plus the
  date window so an admin cannot accidentally leave a long-expired BAA
  marked ``active``.
* Every mutation bumps a monotonic ``version`` and is written through
  the admin-audit chain by the route layer.
* Every read and write is strictly tenant-scoped.

This module mirrors :mod:`adherence_common.dpia` so the existing audit,
retention, and admin-MFA scaffolding apply without modification.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional

from sqlalchemy import (
    Column,
    Date,
    DateTime,
    Integer,
    String,
    Text,
    UniqueConstraint,
    select,
)

from adherence_common.db import Base, session


MIN_COUNTERPARTY_LEN = 2
MAX_COUNTERPARTY_LEN = 200
MAX_DOC_VERSION_LEN = 64
MAX_SIGNATORY_LEN = 200
MAX_EVIDENCE_URL_LEN = 1024
MAX_NOTES_LEN = 4096

# HIPAA Breach Notification Rule (45 CFR 164.410) caps at 60 days; most
# covered entities contract for 24 to 72 hours.
DEFAULT_BREACH_NOTIFY_HOURS = 72
MIN_BREACH_NOTIFY_HOURS = 1
MAX_BREACH_NOTIFY_HOURS = 60 * 24

STATUSES = ("draft", "active", "expired", "terminated")


class BaaError(ValueError):
    """Raised when a BAA entry input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise BaaError(f"value too long (max {max_len})")
    return t


def _required(s: str, *, field: str, min_len: int, max_len: int) -> str:
    if s is None:
        raise BaaError(f"{field} is required")
    t = str(s).strip()
    if len(t) < min_len:
        raise BaaError(f"{field} must be at least {min_len} characters")
    if len(t) > max_len:
        raise BaaError(f"{field} must be at most {max_len} characters")
    return t


def _status(value: str) -> str:
    t = (value or "").strip().lower()
    if t not in STATUSES:
        raise BaaError(f"status must be one of: {', '.join(STATUSES)}")
    return t


def _hours(n: Optional[int], *, default: int) -> int:
    if n is None:
        return default
    try:
        v = int(n)
    except (TypeError, ValueError) as exc:
        raise BaaError("breach_notify_hours must be an integer") from exc
    if v < MIN_BREACH_NOTIFY_HOURS or v > MAX_BREACH_NOTIFY_HOURS:
        raise BaaError(
            "breach_notify_hours must be between "
            f"{MIN_BREACH_NOTIFY_HOURS} and {MAX_BREACH_NOTIFY_HOURS}"
        )
    return v


def _coerce_date(value, *, field: str) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError as exc:
            raise BaaError(f"{field} must be ISO-8601 date YYYY-MM-DD") from exc
    raise BaaError(f"{field} must be a date")


def _coerce_optional_date(value, *, field: str) -> Optional[date]:
    if value is None:
        return None
    return _coerce_date(value, field=field)


class BaaEntry(Base):
    __tablename__ = "baa_entries"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "counterparty",
            "document_version",
            name="uq_baa_tenant_counterparty_docver",
        ),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    counterparty = Column(String(MAX_COUNTERPARTY_LEN), nullable=False)
    document_version = Column(String(MAX_DOC_VERSION_LEN), nullable=False)
    status = Column(String(16), nullable=False, default="draft")
    effective_on = Column(Date, nullable=True, index=True)
    expires_on = Column(Date, nullable=True, index=True)
    breach_notify_hours = Column(
        Integer, nullable=False, default=DEFAULT_BREACH_NOTIFY_HOURS
    )
    covered_entity_signatory = Column(String(MAX_SIGNATORY_LEN), nullable=True)
    business_associate_signatory = Column(String(MAX_SIGNATORY_LEN), nullable=True)
    evidence_url = Column(String(MAX_EVIDENCE_URL_LEN), nullable=True)
    notes = Column(Text, nullable=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)


@dataclass(frozen=True)
class BaaView:
    id: int
    tenant_id: str
    counterparty: str
    document_version: str
    status: str
    effective_status: str
    effective_on: Optional[str]
    expires_on: Optional[str]
    breach_notify_hours: int
    covered_entity_signatory: Optional[str]
    business_associate_signatory: Optional[str]
    evidence_url: Optional[str]
    notes: Optional[str]
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]


def _effective_status(
    *,
    status: str,
    effective_on: Optional[date],
    expires_on: Optional[date],
    today: Optional[date] = None,
) -> str:
    s = (status or "draft").lower()
    if s == "terminated":
        return "terminated"
    n = today or date.today()
    if s == "active":
        if effective_on is not None and effective_on > n:
            return "draft"
        if expires_on is not None and expires_on < n:
            return "expired"
        return "active"
    if s == "expired":
        return "expired"
    return "draft"


def _to_view(row: BaaEntry, *, today: Optional[date] = None) -> BaaView:
    eff = _effective_status(
        status=str(row.status or "draft"),
        effective_on=row.effective_on,
        expires_on=row.expires_on,
        today=today,
    )
    return BaaView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        counterparty=str(row.counterparty),
        document_version=str(row.document_version),
        status=str(row.status or "draft"),
        effective_status=eff,
        effective_on=(row.effective_on.isoformat() if row.effective_on else None),
        expires_on=(row.expires_on.isoformat() if row.expires_on else None),
        breach_notify_hours=int(
            row.breach_notify_hours or DEFAULT_BREACH_NOTIFY_HOURS
        ),
        covered_entity_signatory=(
            str(row.covered_entity_signatory)
            if row.covered_entity_signatory
            else None
        ),
        business_associate_signatory=(
            str(row.business_associate_signatory)
            if row.business_associate_signatory
            else None
        ),
        evidence_url=(str(row.evidence_url) if row.evidence_url else None),
        notes=(str(row.notes) if row.notes else None),
        version=int(row.version or 1),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=(row.updated_at.isoformat() if row.updated_at else None),
    )


def create_entry(
    *,
    tenant_id: str,
    counterparty: str,
    document_version: str,
    created_by: str,
    status: str = "draft",
    effective_on=None,
    expires_on=None,
    breach_notify_hours: Optional[int] = None,
    covered_entity_signatory: Optional[str] = None,
    business_associate_signatory: Optional[str] = None,
    evidence_url: Optional[str] = None,
    notes: Optional[str] = None,
) -> BaaView:
    tid = (tenant_id or "default")[:64]
    cparty = _required(
        counterparty,
        field="counterparty",
        min_len=MIN_COUNTERPARTY_LEN,
        max_len=MAX_COUNTERPARTY_LEN,
    )
    dver = _required(
        document_version,
        field="document_version",
        min_len=1,
        max_len=MAX_DOC_VERSION_LEN,
    )
    st = _status(status)
    eff = _coerce_optional_date(effective_on, field="effective_on")
    exp = _coerce_optional_date(expires_on, field="expires_on")
    if eff is not None and exp is not None and exp < eff:
        raise BaaError("expires_on must not be before effective_on")
    hrs = _hours(breach_notify_hours, default=DEFAULT_BREACH_NOTIFY_HOURS)
    actor = (created_by or "unknown")[:128]
    with session() as s:
        existing = s.execute(
            select(BaaEntry).where(
                BaaEntry.tenant_id == tid,
                BaaEntry.counterparty == cparty,
                BaaEntry.document_version == dver,
                BaaEntry.status != "terminated",
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise BaaError(
                "a non-terminated BAA with that counterparty and document_version "
                "already exists for this workspace"
            )
        row = BaaEntry(
            tenant_id=tid,
            counterparty=cparty,
            document_version=dver,
            status=st,
            effective_on=eff,
            expires_on=exp,
            breach_notify_hours=hrs,
            covered_entity_signatory=_clean(
                covered_entity_signatory, max_len=MAX_SIGNATORY_LEN
            ),
            business_associate_signatory=_clean(
                business_associate_signatory, max_len=MAX_SIGNATORY_LEN
            ),
            evidence_url=_clean(evidence_url, max_len=MAX_EVIDENCE_URL_LEN),
            notes=_clean(notes, max_len=MAX_NOTES_LEN),
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
    status: Optional[str] = None,
    effective_on=None,
    expires_on=None,
    breach_notify_hours: Optional[int] = None,
    covered_entity_signatory: Optional[str] = None,
    business_associate_signatory: Optional[str] = None,
    evidence_url: Optional[str] = None,
    notes: Optional[str] = None,
) -> Optional[BaaView]:
    """Update one entry, strictly scoped to ``tenant_id``."""
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(BaaEntry).where(
                BaaEntry.tenant_id == tid,
                BaaEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if status is not None:
            row.status = _status(status)
        if effective_on is not None:
            row.effective_on = _coerce_date(effective_on, field="effective_on")
        if expires_on is not None:
            row.expires_on = _coerce_date(expires_on, field="expires_on")
        if (
            row.effective_on is not None
            and row.expires_on is not None
            and row.expires_on < row.effective_on
        ):
            raise BaaError("expires_on must not be before effective_on")
        if breach_notify_hours is not None:
            row.breach_notify_hours = _hours(
                breach_notify_hours, default=DEFAULT_BREACH_NOTIFY_HOURS
            )
        if covered_entity_signatory is not None:
            row.covered_entity_signatory = _clean(
                covered_entity_signatory, max_len=MAX_SIGNATORY_LEN
            )
        if business_associate_signatory is not None:
            row.business_associate_signatory = _clean(
                business_associate_signatory, max_len=MAX_SIGNATORY_LEN
            )
        if evidence_url is not None:
            row.evidence_url = _clean(evidence_url, max_len=MAX_EVIDENCE_URL_LEN)
        if notes is not None:
            row.notes = _clean(notes, max_len=MAX_NOTES_LEN)
        row.version = int(row.version or 1) + 1
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def terminate_entry(
    *, tenant_id: str, entry_id: int, terminated_by: str
) -> Optional[BaaView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(BaaEntry).where(
                BaaEntry.tenant_id == tid,
                BaaEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if row.status == "terminated":
            return _to_view(row)
        row.status = "terminated"
        row.version = int(row.version or 1) + 1
        row.updated_by = (terminated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def list_entries(
    *,
    tenant_id: str,
    include_terminated: bool = False,
    limit: int = 200,
    offset: int = 0,
) -> list[BaaView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(BaaEntry).where(BaaEntry.tenant_id == tid)
        if not include_terminated:
            q = q.where(BaaEntry.status != "terminated")
        q = q.order_by(BaaEntry.id.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_entry(*, tenant_id: str, entry_id: int) -> Optional[BaaView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(BaaEntry).where(
                BaaEntry.tenant_id == tid,
                BaaEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def has_active(tenant_id: str, *, today: Optional[date] = None) -> bool:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            rows = (
                s.execute(
                    select(BaaEntry).where(
                        BaaEntry.tenant_id == tid,
                        BaaEntry.status == "active",
                    )
                )
                .scalars()
                .all()
            )
    except Exception:
        return False
    for r in rows:
        if (
            _effective_status(
                status=str(r.status),
                effective_on=r.effective_on,
                expires_on=r.expires_on,
                today=today,
            )
            == "active"
        ):
            return True
    return False


def active_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            rows = (
                s.execute(
                    select(BaaEntry).where(
                        BaaEntry.tenant_id == tid,
                        BaaEntry.status == "active",
                    )
                )
                .scalars()
                .all()
            )
    except Exception:
        return 0
    n = date.today()
    return sum(
        1
        for r in rows
        if _effective_status(
            status=str(r.status),
            effective_on=r.effective_on,
            expires_on=r.expires_on,
            today=n,
        )
        == "active"
    )


def expiring_within(tenant_id: str, *, days: int) -> int:
    tid = (tenant_id or "default")[:64]
    if days < 0:
        return 0
    try:
        with session() as s:
            rows = (
                s.execute(
                    select(BaaEntry).where(
                        BaaEntry.tenant_id == tid,
                        BaaEntry.status == "active",
                        BaaEntry.expires_on.is_not(None),
                    )
                )
                .scalars()
                .all()
            )
    except Exception:
        return 0
    n = date.today()
    cutoff_ord = n.toordinal() + int(days)
    out = 0
    for r in rows:
        if r.expires_on is None:
            continue
        eff = _effective_status(
            status=str(r.status),
            effective_on=r.effective_on,
            expires_on=r.expires_on,
            today=n,
        )
        if eff != "active":
            continue
        if r.expires_on.toordinal() <= cutoff_ord:
            out += 1
    return out


class BaaPolicy(Base):
    __tablename__ = "baa_policy"
    tenant_id = Column(String(64), primary_key=True)
    require_baa_for_phi = Column(Integer, nullable=False, default=0)
    grace_until = Column(Date, nullable=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


@dataclass(frozen=True)
class BaaPolicyView:
    tenant_id: str
    require_baa_for_phi: bool
    grace_until: Optional[str]
    updated_by: Optional[str]
    updated_at: str


def _policy_to_view(row: BaaPolicy) -> BaaPolicyView:
    return BaaPolicyView(
        tenant_id=str(row.tenant_id),
        require_baa_for_phi=bool(int(row.require_baa_for_phi or 0)),
        grace_until=(row.grace_until.isoformat() if row.grace_until else None),
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=row.updated_at.isoformat() if row.updated_at else "",
    )


def get_policy(tenant_id: str) -> BaaPolicyView:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.get(BaaPolicy, tid)
        if row is None:
            row = BaaPolicy(
                tenant_id=tid,
                require_baa_for_phi=0,
                grace_until=None,
                updated_by=None,
                updated_at=datetime.utcnow(),
            )
            s.add(row)
            s.commit()
            s.refresh(row)
        return _policy_to_view(row)


def set_policy(
    *,
    tenant_id: str,
    require_baa_for_phi: bool,
    grace_until=None,
    updated_by: str,
) -> BaaPolicyView:
    tid = (tenant_id or "default")[:64]
    grace = _coerce_optional_date(grace_until, field="grace_until")
    with session() as s:
        row = s.get(BaaPolicy, tid)
        if row is None:
            row = BaaPolicy(tenant_id=tid)
            s.add(row)
        row.require_baa_for_phi = 1 if require_baa_for_phi else 0
        row.grace_until = grace
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _policy_to_view(row)


def enforcement_state(tenant_id: str, *, today: Optional[date] = None) -> dict:
    """Decide whether PHI access should be blocked for this tenant."""
    pol = get_policy(tenant_id)
    n = today or date.today()
    in_grace = False
    if pol.grace_until is not None:
        try:
            in_grace = date.fromisoformat(pol.grace_until) >= n
        except ValueError:
            in_grace = False
    active = has_active(tenant_id, today=n)
    should_block = bool(pol.require_baa_for_phi and not active and not in_grace)
    return {
        "require_baa_for_phi": pol.require_baa_for_phi,
        "in_grace": in_grace,
        "grace_until": pol.grace_until,
        "has_active_baa": active,
        "should_block": should_block,
    }
