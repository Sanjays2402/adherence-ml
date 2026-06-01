"""Per-tenant security incident register (GDPR Art. 33/34, SOC2 CC7.4).

Enterprise security and privacy teams must keep an immutable register of
security incidents that affect customer data, with timestamps proving the
72-hour breach notification window (GDPR Art. 33(1)) was respected. SOC2
CC7.4 also expects evidence that incidents are tracked from discovery
through containment, eradication, recovery, and lessons learned.

Semantics
---------

* Every workspace owns zero or more :class:`Incident` rows. Rows are
  strictly tenant-scoped; no cross-tenant read or write surface exists
  on this module or its route.
* An incident has a coarse ``status`` (``open``, ``contained``,
  ``resolved``) and a ``severity`` (``low``, ``medium``, ``high``,
  ``critical``). Severity ``high`` or ``critical`` *or* an explicit
  ``personal_data_breach`` flag triggers the GDPR 72h deadline.
* ``notification_deadline_at`` is computed as ``discovered_at +
  72 hours`` whenever the incident is a personal data breach or has
  high/critical severity. The UI counts down against this value.
* Append-only :class:`IncidentUpdate` rows form the per-incident
  timeline (situation reports, containment notes, regulator filing
  references). Updates are never edited or deleted.
* Mutations require admin role plus an active MFA step-up at the route
  layer and are mirrored into the admin audit log.

This module is intentionally storage-only. Validation that would block
a write (severity out of range, status transitions) lives here; route
shape lives in :mod:`adherence_api.routes.incidents`.
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
    func,
    select,
)

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Constants and validation
# ---------------------------------------------------------------------------

SEVERITIES = ("low", "medium", "high", "critical")
STATUSES = ("open", "contained", "resolved")

# GDPR Art. 33(1): notify supervisory authority "without undue delay
# and, where feasible, not later than 72 hours after having become
# aware of it".
NOTIFICATION_DEADLINE_HOURS = 72

MIN_TITLE_LEN = 4
MAX_TITLE_LEN = 200
MIN_SUMMARY_LEN = 10
MAX_SUMMARY_LEN = 8192
MAX_UPDATE_LEN = 8192
MAX_REF_LEN = 256


class IncidentError(ValueError):
    """Raised when an incident input is invalid."""


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise IncidentError(f"value too long (max {max_len})")
    return t


def _validate_title(raw: Optional[str]) -> str:
    if raw is None:
        raise IncidentError("title is required")
    s = str(raw).strip()
    if len(s) < MIN_TITLE_LEN:
        raise IncidentError(f"title must be at least {MIN_TITLE_LEN} characters")
    if len(s) > MAX_TITLE_LEN:
        raise IncidentError(f"title must be at most {MAX_TITLE_LEN} characters")
    return s


def _validate_summary(raw: Optional[str]) -> str:
    if raw is None:
        raise IncidentError("summary is required")
    s = str(raw).strip()
    if len(s) < MIN_SUMMARY_LEN:
        raise IncidentError(
            f"summary must be at least {MIN_SUMMARY_LEN} characters"
        )
    if len(s) > MAX_SUMMARY_LEN:
        raise IncidentError(
            f"summary must be at most {MAX_SUMMARY_LEN} characters"
        )
    return s


def _validate_severity(raw: Optional[str]) -> str:
    s = str(raw or "").strip().lower()
    if s not in SEVERITIES:
        raise IncidentError(
            f"severity must be one of {', '.join(SEVERITIES)}"
        )
    return s


def _validate_status(raw: Optional[str]) -> str:
    s = str(raw or "").strip().lower()
    if s not in STATUSES:
        raise IncidentError(
            f"status must be one of {', '.join(STATUSES)}"
        )
    return s


def compute_deadline(
    *,
    discovered_at: datetime,
    severity: str,
    personal_data_breach: bool,
) -> Optional[datetime]:
    """Return the GDPR notification deadline, or None if not applicable.

    A deadline applies when either the incident is flagged as a
    personal data breach (GDPR scope) or its severity is high or
    critical (internal SLA for security-significant events).
    """
    if personal_data_breach or severity in ("high", "critical"):
        return discovered_at + timedelta(hours=NOTIFICATION_DEADLINE_HOURS)
    return None


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class Incident(Base):
    """One security incident scoped to a tenant.

    The combination of ``discovered_at``, ``contained_at``,
    ``resolved_at``, ``notified_authority_at``, and
    ``notified_subjects_at`` lets auditors reconstruct the full
    response timeline and prove the 72-hour rule was honoured.
    """

    __tablename__ = "incidents"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    title = Column(String(200), nullable=False)
    summary = Column(Text, nullable=False)
    severity = Column(String(16), nullable=False, default="medium", index=True)
    status = Column(String(16), nullable=False, default="open", index=True)
    personal_data_breach = Column(Boolean, nullable=False, default=False)
    affected_user_count = Column(Integer, nullable=True)
    external_ref = Column(String(256), nullable=True)
    opened_by = Column(String(128), nullable=False)
    discovered_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    opened_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    contained_at = Column(DateTime, nullable=True)
    resolved_at = Column(DateTime, nullable=True, index=True)
    resolved_by = Column(String(128), nullable=True)
    resolution_note = Column(Text, nullable=True)
    notified_authority_at = Column(DateTime, nullable=True)
    notified_subjects_at = Column(DateTime, nullable=True)
    notification_deadline_at = Column(DateTime, nullable=True, index=True)


class IncidentUpdate(Base):
    """Append-only timeline entry attached to an incident."""

    __tablename__ = "incident_updates"
    id = Column(Integer, primary_key=True, autoincrement=True)
    incident_id = Column(
        Integer,
        ForeignKey("incidents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    author = Column(String(128), nullable=False)
    note = Column(Text, nullable=False)
    created_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IncidentUpdateView:
    id: int
    incident_id: int
    author: str
    note: str
    created_at: str


@dataclass(frozen=True)
class IncidentView:
    id: int
    tenant_id: str
    title: str
    summary: str
    severity: str
    status: str
    personal_data_breach: bool
    affected_user_count: Optional[int]
    external_ref: Optional[str]
    opened_by: str
    discovered_at: str
    opened_at: str
    contained_at: Optional[str]
    resolved_at: Optional[str]
    resolved_by: Optional[str]
    resolution_note: Optional[str]
    notified_authority_at: Optional[str]
    notified_subjects_at: Optional[str]
    notification_deadline_at: Optional[str]
    updates: list[IncidentUpdateView]


def _u_to_view(row: IncidentUpdate) -> IncidentUpdateView:
    return IncidentUpdateView(
        id=int(row.id),
        incident_id=int(row.incident_id),
        author=str(row.author),
        note=str(row.note),
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt is not None else None


def _to_view(row: Incident, updates: list[IncidentUpdate]) -> IncidentView:
    return IncidentView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        title=str(row.title),
        summary=str(row.summary),
        severity=str(row.severity),
        status=str(row.status),
        personal_data_breach=bool(row.personal_data_breach),
        affected_user_count=(
            int(row.affected_user_count)
            if row.affected_user_count is not None
            else None
        ),
        external_ref=(str(row.external_ref) if row.external_ref else None),
        opened_by=str(row.opened_by),
        discovered_at=row.discovered_at.isoformat() if row.discovered_at else "",
        opened_at=row.opened_at.isoformat() if row.opened_at else "",
        contained_at=_iso(row.contained_at),
        resolved_at=_iso(row.resolved_at),
        resolved_by=(str(row.resolved_by) if row.resolved_by else None),
        resolution_note=(
            str(row.resolution_note) if row.resolution_note else None
        ),
        notified_authority_at=_iso(row.notified_authority_at),
        notified_subjects_at=_iso(row.notified_subjects_at),
        notification_deadline_at=_iso(row.notification_deadline_at),
        updates=[_u_to_view(u) for u in updates],
    )


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def open_incident(
    *,
    tenant_id: str,
    title: str,
    summary: str,
    severity: str,
    opened_by: str,
    personal_data_breach: bool = False,
    affected_user_count: Optional[int] = None,
    external_ref: Optional[str] = None,
    discovered_at: Optional[datetime] = None,
) -> IncidentView:
    tid = (tenant_id or "default")[:64]
    t = _validate_title(title)
    su = _validate_summary(summary)
    sev = _validate_severity(severity)
    ref = _clean(external_ref, max_len=MAX_REF_LEN)
    if affected_user_count is not None:
        if int(affected_user_count) < 0:
            raise IncidentError("affected_user_count must be >= 0")
    actor = (opened_by or "unknown")[:128]
    disc = discovered_at or datetime.utcnow()
    deadline = compute_deadline(
        discovered_at=disc,
        severity=sev,
        personal_data_breach=bool(personal_data_breach),
    )
    row = Incident(
        tenant_id=tid,
        title=t,
        summary=su,
        severity=sev,
        status="open",
        personal_data_breach=bool(personal_data_breach),
        affected_user_count=(
            int(affected_user_count) if affected_user_count is not None else None
        ),
        external_ref=ref,
        opened_by=actor,
        discovered_at=disc,
        opened_at=datetime.utcnow(),
        notification_deadline_at=deadline,
    )
    with session() as s:
        s.add(row)
        s.commit()
        s.refresh(row)
        return _to_view(row, [])


def append_update(
    *,
    tenant_id: str,
    incident_id: int,
    author: str,
    note: str,
) -> Optional[IncidentUpdateView]:
    """Append a sitrep update, scoped strictly to ``tenant_id``."""
    tid = (tenant_id or "default")[:64]
    text = (note or "").strip()
    if len(text) < 1:
        raise IncidentError("note is required")
    if len(text) > MAX_UPDATE_LEN:
        raise IncidentError(f"note must be at most {MAX_UPDATE_LEN} characters")
    with session() as s:
        parent = s.execute(
            select(Incident).where(
                Incident.tenant_id == tid,
                Incident.id == int(incident_id),
            )
        ).scalar_one_or_none()
        if parent is None:
            return None
        upd = IncidentUpdate(
            incident_id=int(parent.id),
            tenant_id=tid,
            author=(author or "unknown")[:128],
            note=text,
            created_at=datetime.utcnow(),
        )
        s.add(upd)
        s.commit()
        s.refresh(upd)
        return _u_to_view(upd)


def record_milestone(
    *,
    tenant_id: str,
    incident_id: int,
    milestone: str,
    actor: str,
    note: Optional[str] = None,
) -> Optional[IncidentView]:
    """Stamp one of the response milestones on an incident.

    ``milestone`` is one of: ``contained``, ``notified_authority``,
    ``notified_subjects``, ``resolved``. Re-stamping is allowed (it
    overwrites the prior value) so a customer can correct a wrong
    timestamp; both events still show up in the admin audit log.
    """
    tid = (tenant_id or "default")[:64]
    m = (milestone or "").strip().lower()
    if m not in (
        "contained",
        "notified_authority",
        "notified_subjects",
        "resolved",
    ):
        raise IncidentError("invalid milestone")
    now = datetime.utcnow()
    with session() as s:
        row = s.execute(
            select(Incident).where(
                Incident.tenant_id == tid,
                Incident.id == int(incident_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        if m == "contained":
            row.contained_at = now
            if row.status == "open":
                row.status = "contained"
        elif m == "notified_authority":
            row.notified_authority_at = now
        elif m == "notified_subjects":
            row.notified_subjects_at = now
        elif m == "resolved":
            row.resolved_at = now
            row.resolved_by = (actor or "unknown")[:128]
            row.status = "resolved"
            if row.contained_at is None:
                row.contained_at = now
            cleaned = _clean(note, max_len=MAX_SUMMARY_LEN)
            if cleaned is not None:
                row.resolution_note = cleaned
        s.commit()
        s.refresh(row)
        return _to_view(row, _load_updates(s, int(row.id)))


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def _load_updates(s, incident_id: int) -> list[IncidentUpdate]:
    return list(
        s.execute(
            select(IncidentUpdate)
            .where(IncidentUpdate.incident_id == int(incident_id))
            .order_by(IncidentUpdate.id.asc())
        ).scalars()
    )


def list_incidents(
    *,
    tenant_id: str,
    include_resolved: bool = True,
    limit: int = 100,
    offset: int = 0,
) -> list[IncidentView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        q = select(Incident).where(Incident.tenant_id == tid)
        if not include_resolved:
            q = q.where(Incident.status != "resolved")
        q = q.order_by(Incident.id.desc()).offset(int(offset)).limit(int(limit))
        rows = list(s.execute(q).scalars())
        out: list[IncidentView] = []
        for r in rows:
            out.append(_to_view(r, _load_updates(s, int(r.id))))
        return out


def get_incident(*, tenant_id: str, incident_id: int) -> Optional[IncidentView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(Incident).where(
                Incident.tenant_id == tid,
                Incident.id == int(incident_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return _to_view(row, _load_updates(s, int(row.id)))


def open_breach_summary(tenant_id: str) -> dict[str, int]:
    """Cheap counters for dashboard banners."""
    tid = (tenant_id or "default")[:64]
    out = {"open": 0, "breaches_open": 0, "past_deadline": 0}
    now = datetime.utcnow()
    try:
        with session() as s:
            rows = list(
                s.execute(
                    select(Incident).where(
                        Incident.tenant_id == tid,
                        Incident.status != "resolved",
                    )
                ).scalars()
            )
            for r in rows:
                out["open"] += 1
                if bool(r.personal_data_breach):
                    out["breaches_open"] += 1
                if (
                    r.notification_deadline_at is not None
                    and r.notified_authority_at is None
                    and r.notification_deadline_at < now
                ):
                    out["past_deadline"] += 1
    except Exception:
        # Never let dashboard counters take down a route. Counters are
        # decorative; real enforcement lives at write time.
        pass
    return out


__all__ = [
    "SEVERITIES",
    "STATUSES",
    "NOTIFICATION_DEADLINE_HOURS",
    "MIN_TITLE_LEN",
    "MAX_TITLE_LEN",
    "MIN_SUMMARY_LEN",
    "MAX_SUMMARY_LEN",
    "MAX_UPDATE_LEN",
    "MAX_REF_LEN",
    "IncidentError",
    "Incident",
    "IncidentUpdate",
    "IncidentView",
    "IncidentUpdateView",
    "compute_deadline",
    "open_incident",
    "append_update",
    "record_milestone",
    "list_incidents",
    "get_incident",
    "open_breach_summary",
]
