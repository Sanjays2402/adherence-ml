"""Per-tenant SLA commitment register.

Enterprise procurement (Master Services Agreement reviews, vendor risk
questionnaires, SOC 2 CC3.4, CAIQ STA-05 and STA-06) routinely asks the
vendor to point at a single durable record of the SLA contractually
committed to *this specific customer*: uptime percentage, support
response targets per severity, recovery time and point objectives, and
the effective dates of the commitment. This module is that record.

Strict tenant scoping: every read and write filters on ``tenant_id``;
there is no cross-tenant code path. One commitment may be active at any
time per tenant. Creating a new commitment archives the prior active
one with a supersede reason and a back-link, so the historical contract
trail stays immutable.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import Column, DateTime, Float, Integer, String, Text, select

from adherence_common.db import Base, session


MIN_REF_LEN = 2
MAX_REF_LEN = 128
MAX_NOTES_LEN = 4096

UPTIME_MIN = 90.0
UPTIME_MAX = 100.0

RESPONSE_HOUR_MIN = 0.25
RESPONSE_HOUR_MAX = 24 * 30

RECOVERY_MIN = 1
RECOVERY_MAX = 60 * 24 * 30


class SLAError(ValueError):
    """Raised when an SLA commitment input is invalid."""


def _ref(s):
    if s is None:
        raise SLAError("contract_ref is required")
    t = str(s).strip()
    if len(t) < MIN_REF_LEN:
        raise SLAError("contract_ref must be at least %d characters" % MIN_REF_LEN)
    if len(t) > MAX_REF_LEN:
        raise SLAError("contract_ref must be at most %d characters" % MAX_REF_LEN)
    return t


def _notes(s):
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > MAX_NOTES_LEN:
        raise SLAError("notes must be at most %d characters" % MAX_NOTES_LEN)
    return t


def _uptime(v):
    try:
        f = float(v)
    except (TypeError, ValueError) as exc:
        raise SLAError("uptime_pct must be a number") from exc
    if not (UPTIME_MIN <= f <= UPTIME_MAX):
        raise SLAError("uptime_pct must be between %s and %s" % (UPTIME_MIN, UPTIME_MAX))
    return round(f, 4)


def _response(v, field):
    try:
        f = float(v)
    except (TypeError, ValueError) as exc:
        raise SLAError("%s must be a number of hours" % field) from exc
    if not (RESPONSE_HOUR_MIN <= f <= RESPONSE_HOUR_MAX):
        raise SLAError("%s must be between %sh and %sh" % (field, RESPONSE_HOUR_MIN, RESPONSE_HOUR_MAX))
    return round(f, 4)


def _recovery(v, field):
    try:
        i = int(v)
    except (TypeError, ValueError) as exc:
        raise SLAError("%s must be an integer number of minutes" % field) from exc
    if not (RECOVERY_MIN <= i <= RECOVERY_MAX):
        raise SLAError("%s must be between %d and %d minutes" % (field, RECOVERY_MIN, RECOVERY_MAX))
    return i


def _coerce_dt(value, field):
    if isinstance(value, datetime):
        return value.replace(microsecond=0)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            raise SLAError("%s is required" % field)
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except ValueError as exc:
            raise SLAError("%s is not a valid ISO 8601 timestamp" % field) from exc
        if dt.tzinfo is not None:
            dt = dt.astimezone(tz=None).replace(tzinfo=None)
        return dt.replace(microsecond=0)
    raise SLAError("%s must be an ISO 8601 timestamp" % field)


def _validate_severity_order(s1, s2, s3, s4):
    if not (s1 <= s2 <= s3 <= s4):
        raise SLAError(
            "severity response targets must be monotonically non-decreasing"
            " from sev1 (strictest) through sev4 (most relaxed)"
        )


def _validate_window(starts, ends):
    if ends is None:
        return
    if ends <= starts:
        raise SLAError("effective_until must be strictly after effective_from")


class SLACommitment(Base):
    """One contractually committed SLA, scoped to a tenant."""

    __tablename__ = "sla_commitments"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    contract_ref = Column(String(MAX_REF_LEN), nullable=False)
    plan = Column(String(64), nullable=False, default="enterprise")
    uptime_pct = Column(Float, nullable=False)
    sev1_response_hours = Column(Float, nullable=False)
    sev2_response_hours = Column(Float, nullable=False)
    sev3_response_hours = Column(Float, nullable=False)
    sev4_response_hours = Column(Float, nullable=False)
    rto_minutes = Column(Integer, nullable=False)
    rpo_minutes = Column(Integer, nullable=False)
    effective_from = Column(DateTime, nullable=False, index=True)
    effective_until = Column(DateTime, nullable=True, index=True)
    notes = Column(Text, nullable=True)
    version = Column(Integer, default=1, nullable=False)
    created_by = Column(String(128), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    archived_by = Column(String(128), nullable=True)
    archived_at = Column(DateTime, nullable=True, index=True)
    archive_reason = Column(String(256), nullable=True)
    superseded_by_id = Column(Integer, nullable=True)


@dataclass(frozen=True)
class SLAView:
    id: int
    tenant_id: str
    contract_ref: str
    plan: str
    uptime_pct: float
    sev1_response_hours: float
    sev2_response_hours: float
    sev3_response_hours: float
    sev4_response_hours: float
    rto_minutes: int
    rpo_minutes: int
    effective_from: str
    effective_until: Optional[str]
    notes: Optional[str]
    version: int
    status: str
    created_by: str
    created_at: str
    archived_by: Optional[str]
    archived_at: Optional[str]
    archive_reason: Optional[str]
    superseded_by_id: Optional[int]
    active: bool


def _status(row, now):
    if row.archived_at is not None:
        return "superseded"
    if row.effective_from > now:
        return "scheduled"
    if row.effective_until is not None and row.effective_until <= now:
        return "expired"
    return "active"


def _to_view(row, now=None):
    n = now or datetime.utcnow()
    return SLAView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        contract_ref=str(row.contract_ref),
        plan=str(row.plan or "enterprise"),
        uptime_pct=float(row.uptime_pct),
        sev1_response_hours=float(row.sev1_response_hours),
        sev2_response_hours=float(row.sev2_response_hours),
        sev3_response_hours=float(row.sev3_response_hours),
        sev4_response_hours=float(row.sev4_response_hours),
        rto_minutes=int(row.rto_minutes),
        rpo_minutes=int(row.rpo_minutes),
        effective_from=row.effective_from.isoformat() if row.effective_from else "",
        effective_until=(row.effective_until.isoformat() if row.effective_until else None),
        notes=(str(row.notes) if row.notes else None),
        version=int(row.version or 1),
        status=_status(row, n),
        created_by=str(row.created_by),
        created_at=row.created_at.isoformat() if row.created_at else "",
        archived_by=(str(row.archived_by) if row.archived_by else None),
        archived_at=(row.archived_at.isoformat() if row.archived_at else None),
        archive_reason=(str(row.archive_reason) if row.archive_reason else None),
        superseded_by_id=(int(row.superseded_by_id) if row.superseded_by_id else None),
        active=(row.archived_at is None),
    )


def list_commitments(*, tenant_id, include_archived=False, limit=200, offset=0):
    tid = (tenant_id or "default")[:64]
    lim = max(1, min(int(limit), 500))
    off = max(0, int(offset))
    with session() as db:
        stmt = select(SLACommitment).where(SLACommitment.tenant_id == tid)
        if not include_archived:
            stmt = stmt.where(SLACommitment.archived_at.is_(None))
        stmt = stmt.order_by(
            SLACommitment.archived_at.is_(None).desc(),
            SLACommitment.effective_from.desc(),
            SLACommitment.id.desc(),
        ).limit(lim).offset(off)
        rows = db.execute(stmt).scalars().all()
        now = datetime.utcnow()
        return [_to_view(r, now) for r in rows]


def get_commitment(*, tenant_id, commitment_id):
    tid = (tenant_id or "default")[:64]
    with session() as db:
        row = db.execute(
            select(SLACommitment).where(
                SLACommitment.tenant_id == tid,
                SLACommitment.id == int(commitment_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def current_commitment(*, tenant_id, at=None):
    """Return the single in-force commitment for the tenant, or None."""
    tid = (tenant_id or "default")[:64]
    n = (at or datetime.utcnow()).replace(microsecond=0)
    with session() as db:
        rows = db.execute(
            select(SLACommitment).where(
                SLACommitment.tenant_id == tid,
                SLACommitment.archived_at.is_(None),
                SLACommitment.effective_from <= n,
            ).order_by(SLACommitment.effective_from.desc())
        ).scalars().all()
        for r in rows:
            if r.effective_until is None or r.effective_until > n:
                return _to_view(r, n)
        return None


def create_commitment(
    *,
    tenant_id,
    contract_ref,
    plan,
    uptime_pct,
    sev1_response_hours,
    sev2_response_hours,
    sev3_response_hours,
    sev4_response_hours,
    rto_minutes,
    rpo_minutes,
    effective_from,
    effective_until=None,
    notes=None,
    created_by,
    supersede_reason=None,
):
    tid = (tenant_id or "default")[:64]
    cref = _ref(contract_ref)
    cplan = (plan or "enterprise").strip().lower()[:64] or "enterprise"
    up = _uptime(uptime_pct)
    s1 = _response(sev1_response_hours, "sev1_response_hours")
    s2 = _response(sev2_response_hours, "sev2_response_hours")
    s3 = _response(sev3_response_hours, "sev3_response_hours")
    s4 = _response(sev4_response_hours, "sev4_response_hours")
    _validate_severity_order(s1, s2, s3, s4)
    rto = _recovery(rto_minutes, "rto_minutes")
    rpo = _recovery(rpo_minutes, "rpo_minutes")
    starts = _coerce_dt(effective_from, "effective_from")
    ends = _coerce_dt(effective_until, "effective_until") if effective_until else None
    _validate_window(starts, ends)
    cnotes = _notes(notes)
    actor = (created_by or "unknown")[:128]
    archive_reason = (supersede_reason or "superseded by new commitment")[:256]
    with session() as db:
        active_rows = db.execute(
            select(SLACommitment).where(
                SLACommitment.tenant_id == tid,
                SLACommitment.archived_at.is_(None),
            )
        ).scalars().all()
        now = datetime.utcnow()
        row = SLACommitment(
            tenant_id=tid,
            contract_ref=cref,
            plan=cplan,
            uptime_pct=up,
            sev1_response_hours=s1,
            sev2_response_hours=s2,
            sev3_response_hours=s3,
            sev4_response_hours=s4,
            rto_minutes=rto,
            rpo_minutes=rpo,
            effective_from=starts,
            effective_until=ends,
            notes=cnotes,
            version=1,
            created_by=actor,
            created_at=now,
        )
        db.add(row)
        db.flush()
        for prior in active_rows:
            prior.archived_by = actor
            prior.archived_at = now
            prior.archive_reason = archive_reason
            prior.superseded_by_id = int(row.id)
            row.version = max(row.version, int(prior.version or 1) + 1)
        db.commit()
        db.refresh(row)
        return _to_view(row)


def archive_commitment(*, tenant_id, commitment_id, archived_by, reason=None):
    tid = (tenant_id or "default")[:64]
    with session() as db:
        row = db.execute(
            select(SLACommitment).where(
                SLACommitment.tenant_id == tid,
                SLACommitment.id == int(commitment_id),
                SLACommitment.archived_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.archived_by = (archived_by or "unknown")[:128]
        row.archived_at = datetime.utcnow()
        row.archive_reason = (reason or "terminated")[:256]
        db.commit()
        db.refresh(row)
        return _to_view(row)


def counts(*, tenant_id):
    tid = (tenant_id or "default")[:64]
    now = datetime.utcnow()
    with session() as db:
        rows = db.execute(
            select(SLACommitment).where(SLACommitment.tenant_id == tid)
        ).scalars().all()
        active = 0
        archived = 0
        in_force = 0
        for r in rows:
            if r.archived_at is None:
                active += 1
                if r.effective_from <= now and (
                    r.effective_until is None or r.effective_until > now
                ):
                    in_force += 1
            else:
                archived += 1
        return {
            "active": active,
            "archived": archived,
            "in_force": in_force,
            "total": len(rows),
        }
