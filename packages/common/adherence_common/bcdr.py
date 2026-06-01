"""Per-tenant Business Continuity and Disaster Recovery (BCDR) declaration register.

Every enterprise procurement questionnaire (SIG Lite section L, CAIQ
domain BCR, ISO 27001 Annex A.17, SOC 2 CC9.1) asks the vendor to
declare, per service tier, its Recovery Time Objective (RTO) and
Recovery Point Objective (RPO), its disaster recovery strategy, the
runbook reference, and the date of the last successful DR test. A
buyer cannot finish a security review without these numbers in
writing, scoped to the workspace they are buying.

This module is the per-workspace register of those declarations. It
sits next to the GDPR Art. 30 RoPA, the Art. 35 DPIA, the Art. 33
incident log, and the maintenance window register so a workspace
owner can hand a regulator or procurement team a complete evidence
pack without leaving the product.

Semantics
---------

* A workspace has zero or more BCDR entries. Each entry declares one
  service or capability: a short name, the recovery tier, RTO and RPO
  in minutes, the DR strategy, a runbook URL, the date and outcome of
  the last DR test, free-text notes, and a test cadence in days.
* ``next_test_due_at`` is derived from ``last_tested_at`` plus the
  cadence; if no test has been recorded it falls back to creation
  time plus the cadence.
* Entries are mutable; every change bumps a monotonic ``version`` and
  the route layer writes an admin audit row.
* Entries can be archived rather than deleted, preserving the
  historical record for the auditor.
* Every read and write is strictly scoped to the caller's tenant.
  There is no cross-tenant code path: ``tenant_id`` is part of every
  query.
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

MIN_NAME_LEN = 2
MAX_NAME_LEN = 128
MAX_NOTES_LEN = 4096
MAX_RUNBOOK_LEN = 512

TIERS = ("tier1", "tier2", "tier3")
STRATEGIES = ("backup_restore", "pilot_light", "warm_standby", "multi_site")
OUTCOMES = ("not_tested", "passed", "partial", "failed")

# RTO/RPO ceilings. A year is plenty to express the worst tier; the
# floor of zero lets a customer declare "no data loss tolerated".
MAX_RTO_MINUTES = 60 * 24 * 365
MAX_RPO_MINUTES = 60 * 24 * 365

# Test cadence. SOC 2 CC9.1 expects annual at a minimum; we allow as
# tight as monthly and as loose as biennial.
DEFAULT_TEST_CADENCE_DAYS = 365
MIN_TEST_CADENCE_DAYS = 30
MAX_TEST_CADENCE_DAYS = 365 * 2


class BcdrError(ValueError):
    """Raised when a BCDR entry input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise BcdrError(f"value too long (max {max_len})")
    return t


def _required_name(s: str) -> str:
    if s is None:
        raise BcdrError("service_name is required")
    t = str(s).strip()
    if len(t) < MIN_NAME_LEN:
        raise BcdrError(f"service_name must be at least {MIN_NAME_LEN} characters")
    if len(t) > MAX_NAME_LEN:
        raise BcdrError(f"service_name must be at most {MAX_NAME_LEN} characters")
    return t


def _tier(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in TIERS:
        raise BcdrError(f"tier must be one of: {', '.join(TIERS)}")
    return t


def _strategy(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in STRATEGIES:
        raise BcdrError(f"strategy must be one of: {', '.join(STRATEGIES)}")
    return t


def _outcome(v: str) -> str:
    t = (v or "").strip().lower()
    if t not in OUTCOMES:
        raise BcdrError(f"outcome must be one of: {', '.join(OUTCOMES)}")
    return t


def _minutes(n: int, *, field: str, ceiling: int) -> int:
    try:
        v = int(n)
    except (TypeError, ValueError) as exc:
        raise BcdrError(f"{field} must be an integer number of minutes") from exc
    if v < 0:
        raise BcdrError(f"{field} cannot be negative")
    if v > ceiling:
        raise BcdrError(f"{field} cannot exceed {ceiling} minutes")
    return v


def _cadence_days(n: Optional[int]) -> int:
    if n is None:
        return DEFAULT_TEST_CADENCE_DAYS
    try:
        v = int(n)
    except (TypeError, ValueError) as exc:
        raise BcdrError("test_cadence_days must be an integer") from exc
    if v < MIN_TEST_CADENCE_DAYS or v > MAX_TEST_CADENCE_DAYS:
        raise BcdrError(
            f"test_cadence_days must be between {MIN_TEST_CADENCE_DAYS} and "
            f"{MAX_TEST_CADENCE_DAYS}"
        )
    return v


def _runbook(s: Optional[str]) -> Optional[str]:
    t = _clean(s, max_len=MAX_RUNBOOK_LEN)
    if t is None:
        return None
    low = t.lower()
    if not (low.startswith("http://") or low.startswith("https://")):
        raise BcdrError("runbook_url must start with http:// or https://")
    return t


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class BcdrEntry(Base):
    """One BCDR declaration, scoped to a tenant.

    ``(tenant_id, service_name)`` is unique among active rows.
    """

    __tablename__ = "bcdr_entries"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "service_name", name="uq_bcdr_tenant_service"
        ),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    service_name = Column(String(MAX_NAME_LEN), nullable=False)
    tier = Column(String(16), nullable=False, default="tier2")
    rto_minutes = Column(Integer, nullable=False, default=240)
    rpo_minutes = Column(Integer, nullable=False, default=60)
    strategy = Column(String(32), nullable=False, default="backup_restore")
    runbook_url = Column(String(MAX_RUNBOOK_LEN), nullable=True)
    notes = Column(Text, nullable=True)
    last_tested_at = Column(DateTime, nullable=True)
    last_outcome = Column(String(16), nullable=False, default="not_tested")
    last_test_notes = Column(Text, nullable=True)
    test_cadence_days = Column(Integer, nullable=False, default=DEFAULT_TEST_CADENCE_DAYS)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    archived_by = Column(String(128), nullable=True)
    archived_at = Column(DateTime, nullable=True, index=True)


@dataclass(frozen=True)
class BcdrView:
    id: int
    tenant_id: str
    service_name: str
    tier: str
    rto_minutes: int
    rpo_minutes: int
    strategy: str
    runbook_url: Optional[str]
    notes: Optional[str]
    last_tested_at: Optional[str]
    last_outcome: str
    last_test_notes: Optional[str]
    test_cadence_days: int
    next_test_due_at: str
    test_overdue: bool
    version: int
    created_by: str
    created_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    archived_by: Optional[str]
    archived_at: Optional[str]
    active: bool


def _next_due(row: BcdrEntry) -> datetime:
    base = row.last_tested_at or row.created_at or datetime.utcnow()
    cadence = int(row.test_cadence_days or DEFAULT_TEST_CADENCE_DAYS)
    return base + timedelta(days=cadence)


def _to_view(row: BcdrEntry, *, now: Optional[datetime] = None) -> BcdrView:
    n = now or datetime.utcnow()
    nxt = _next_due(row)
    overdue = bool(row.archived_at is None and nxt < n)
    return BcdrView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        service_name=str(row.service_name),
        tier=str(row.tier or "tier2"),
        rto_minutes=int(row.rto_minutes or 0),
        rpo_minutes=int(row.rpo_minutes or 0),
        strategy=str(row.strategy or "backup_restore"),
        runbook_url=(str(row.runbook_url) if row.runbook_url else None),
        notes=(str(row.notes) if row.notes else None),
        last_tested_at=(
            row.last_tested_at.isoformat() if row.last_tested_at else None
        ),
        last_outcome=str(row.last_outcome or "not_tested"),
        last_test_notes=(
            str(row.last_test_notes) if row.last_test_notes else None
        ),
        test_cadence_days=int(row.test_cadence_days or DEFAULT_TEST_CADENCE_DAYS),
        next_test_due_at=nxt.isoformat(),
        test_overdue=overdue,
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
    service_name: str,
    tier: str,
    rto_minutes: int,
    rpo_minutes: int,
    strategy: str,
    created_by: str,
    runbook_url: Optional[str] = None,
    notes: Optional[str] = None,
    test_cadence_days: Optional[int] = None,
) -> BcdrView:
    tid = (tenant_id or "default")[:64]
    cname = _required_name(service_name)
    ctier = _tier(tier)
    crto = _minutes(rto_minutes, field="rto_minutes", ceiling=MAX_RTO_MINUTES)
    crpo = _minutes(rpo_minutes, field="rpo_minutes", ceiling=MAX_RPO_MINUTES)
    cstrat = _strategy(strategy)
    crun = _runbook(runbook_url)
    cnotes = _clean(notes, max_len=MAX_NOTES_LEN)
    cadence = _cadence_days(test_cadence_days)
    actor = (created_by or "unknown")[:128]
    with session() as s:
        existing = s.execute(
            select(BcdrEntry).where(
                BcdrEntry.tenant_id == tid,
                BcdrEntry.service_name == cname,
                BcdrEntry.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise BcdrError(
                f"a BCDR entry for service {cname!r} already exists for this workspace"
            )
        row = BcdrEntry(
            tenant_id=tid,
            service_name=cname,
            tier=ctier,
            rto_minutes=crto,
            rpo_minutes=crpo,
            strategy=cstrat,
            runbook_url=crun,
            notes=cnotes,
            last_tested_at=None,
            last_outcome="not_tested",
            last_test_notes=None,
            test_cadence_days=cadence,
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
    tier: Optional[str] = None,
    rto_minutes: Optional[int] = None,
    rpo_minutes: Optional[int] = None,
    strategy: Optional[str] = None,
    runbook_url: Optional[str] = None,
    notes: Optional[str] = None,
    test_cadence_days: Optional[int] = None,
) -> Optional[BcdrView]:
    """Update one entry, strictly scoped to ``tenant_id``.

    Returns ``None`` if no active entry with that id exists for the
    tenant. The tenant scope on the query is the multi-tenancy gate.
    Every successful change bumps ``version``.
    """
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(BcdrEntry).where(
                BcdrEntry.tenant_id == tid,
                BcdrEntry.id == int(entry_id),
                BcdrEntry.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if tier is not None:
            row.tier = _tier(tier)
        if rto_minutes is not None:
            row.rto_minutes = _minutes(
                rto_minutes, field="rto_minutes", ceiling=MAX_RTO_MINUTES
            )
        if rpo_minutes is not None:
            row.rpo_minutes = _minutes(
                rpo_minutes, field="rpo_minutes", ceiling=MAX_RPO_MINUTES
            )
        if strategy is not None:
            row.strategy = _strategy(strategy)
        if runbook_url is not None:
            row.runbook_url = _runbook(runbook_url) if runbook_url else None
        if notes is not None:
            row.notes = _clean(notes, max_len=MAX_NOTES_LEN)
        if test_cadence_days is not None:
            row.test_cadence_days = _cadence_days(test_cadence_days)
        row.version = int(row.version or 1) + 1
        row.updated_by = (updated_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def record_test(
    *,
    tenant_id: str,
    entry_id: int,
    outcome: str,
    tested_by: str,
    tested_at: Optional[datetime] = None,
    test_notes: Optional[str] = None,
) -> Optional[BcdrView]:
    """Record a DR test outcome against an entry.

    Bumps ``version``, refreshes ``last_tested_at`` and
    ``last_outcome``, and writes a short note. Returns ``None`` when
    the entry is not active for this tenant.
    """
    tid = (tenant_id or "default")[:64]
    coutcome = _outcome(outcome)
    cnotes = _clean(test_notes, max_len=MAX_NOTES_LEN)
    when = tested_at or datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(BcdrEntry).where(
                BcdrEntry.tenant_id == tid,
                BcdrEntry.id == int(entry_id),
                BcdrEntry.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.last_tested_at = when
        row.last_outcome = coutcome
        row.last_test_notes = cnotes
        row.version = int(row.version or 1) + 1
        row.updated_by = (tested_by or "unknown")[:128]
        row.updated_at = datetime.utcnow()
        s.commit()
        s.refresh(row)
        return _to_view(row)


def archive_entry(
    *,
    tenant_id: str,
    entry_id: int,
    archived_by: str,
) -> Optional[BcdrView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(BcdrEntry).where(
                BcdrEntry.tenant_id == tid,
                BcdrEntry.id == int(entry_id),
                BcdrEntry.archived_at.is_(None),
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
) -> list[BcdrView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(BcdrEntry).where(BcdrEntry.tenant_id == tid)
        if not include_archived:
            q = q.where(BcdrEntry.archived_at.is_(None))
        q = q.order_by(BcdrEntry.id.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in s.execute(q).scalars().all()]


def get_entry(*, tenant_id: str, entry_id: int) -> Optional[BcdrView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(BcdrEntry).where(
                BcdrEntry.tenant_id == tid,
                BcdrEntry.id == int(entry_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def active_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            return len(
                s.execute(
                    select(BcdrEntry).where(
                        BcdrEntry.tenant_id == tid,
                        BcdrEntry.archived_at.is_(None),
                    )
                ).all()
            )
    except Exception:
        return 0


def overdue_count(tenant_id: str) -> int:
    tid = (tenant_id or "default")[:64]
    try:
        with session() as s:
            rows = s.execute(
                select(BcdrEntry).where(
                    BcdrEntry.tenant_id == tid,
                    BcdrEntry.archived_at.is_(None),
                )
            ).scalars().all()
    except Exception:
        return 0
    now = datetime.utcnow()
    return sum(1 for r in rows if _next_due(r) < now)


__all__ = [
    "TIERS",
    "STRATEGIES",
    "OUTCOMES",
    "DEFAULT_TEST_CADENCE_DAYS",
    "MIN_TEST_CADENCE_DAYS",
    "MAX_TEST_CADENCE_DAYS",
    "MIN_NAME_LEN",
    "MAX_NAME_LEN",
    "MAX_NOTES_LEN",
    "MAX_RUNBOOK_LEN",
    "MAX_RTO_MINUTES",
    "MAX_RPO_MINUTES",
    "BcdrError",
    "BcdrEntry",
    "BcdrView",
    "create_entry",
    "update_entry",
    "record_test",
    "archive_entry",
    "list_entries",
    "get_entry",
    "active_count",
    "overdue_count",
]
