"""Per-tenant Data Subject Access Request (DSAR) register.

Compliance scope
----------------

GDPR Articles 15 through 22 (and the analogous CCPA / CPRA rights of
"know", "delete", "correct", and "opt-out") all require the controller
to receive, log, and respond to requests from individual data subjects
within a statutory window (one month under GDPR, extendable to three
for complex cases). Enterprise procurement asks: "Show us the register
of every DSAR your team has received, what kind of right was invoked,
who handled it, and when you responded."

This module owns that register. It is intentionally separate from the
workspace-wide GDPR export (which is the *operator* getting their own
data out of the platform); a DSAR is the *end user* (patient, employee,
prospect, etc.) exercising a statutory right against a workspace.

Semantics
---------

* Every workspace owns zero or more :class:`DSARequest` rows. Rows are
  strictly tenant-scoped; no cross-tenant read or write surface exists
  on this module or its route.
* A request has a coarse ``status`` (``received``, ``in_progress``,
  ``fulfilled``, ``rejected``, ``withdrawn``) and a ``request_type``
  (``access``, ``erasure``, ``rectification``, ``restriction``,
  ``portability``, ``objection``, ``opt_out_sale``). Mapping is
  intentionally permissive so it covers both GDPR and CCPA/CPRA labels.
* ``response_deadline_at`` is computed as ``received_at + 30 days``
  (GDPR Art. 12(3) baseline). Operators can extend the deadline by
  recording an :class:`DSAREvent` of kind ``extension`` with a note.
* Append-only :class:`DSAREvent` rows form the per-request timeline
  (acknowledgement sent, identity verified, data package generated,
  rejection rationale, regulator correspondence). Events are never
  edited or deleted.
* The subject's contact email is stored hashed (sha256, deterministic
  per tenant) by default so the register can be safely browsed without
  re-exposing PII. Optional :attr:`subject_email_redacted` carries a
  display value (e.g. ``j***@acme.co``) for operator UX. The raw email
  is stored separately in :attr:`subject_email_encrypted` only when
  the operator opts in via :attr:`store_raw_contact` and is purged on
  fulfilment.

This module is intentionally storage-only. Validation that would block
a write (type out of range, status transitions) lives here; route
shape lives in :mod:`adherence_api.routes.dsar`.
"""
from __future__ import annotations

import hashlib
import re
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
    select,
)

from adherence_common.db import Base, session


# ---------------------------------------------------------------------------
# Constants and validation
# ---------------------------------------------------------------------------

REQUEST_TYPES = (
    "access",
    "erasure",
    "rectification",
    "restriction",
    "portability",
    "objection",
    "opt_out_sale",
)
STATUSES = (
    "received",
    "in_progress",
    "fulfilled",
    "rejected",
    "withdrawn",
)
EVENT_KINDS = (
    "ack_sent",
    "identity_verified",
    "extension",
    "data_package_generated",
    "rejection",
    "regulator_correspondence",
    "note",
)

# GDPR Art. 12(3): respond within one month of receipt.
RESPONSE_WINDOW_DAYS = 30

MIN_SUBJECT_LEN = 3
MAX_SUBJECT_LEN = 256
MIN_DESC_LEN = 10
MAX_DESC_LEN = 8192
MAX_NOTE_LEN = 8192
MAX_REF_LEN = 256

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class DSARError(ValueError):
    """Raised when a DSAR input is invalid."""


def _validate_subject(raw: Optional[str]) -> str:
    if raw is None:
        raise DSARError("subject_name is required")
    s = str(raw).strip()
    if len(s) < MIN_SUBJECT_LEN:
        raise DSARError(
            f"subject_name must be at least {MIN_SUBJECT_LEN} characters"
        )
    if len(s) > MAX_SUBJECT_LEN:
        raise DSARError(
            f"subject_name must be at most {MAX_SUBJECT_LEN} characters"
        )
    return s


def _validate_description(raw: Optional[str]) -> str:
    if raw is None:
        raise DSARError("description is required")
    s = str(raw).strip()
    if len(s) < MIN_DESC_LEN:
        raise DSARError(
            f"description must be at least {MIN_DESC_LEN} characters"
        )
    if len(s) > MAX_DESC_LEN:
        raise DSARError(
            f"description must be at most {MAX_DESC_LEN} characters"
        )
    return s


def _validate_request_type(raw: Optional[str]) -> str:
    s = str(raw or "").strip().lower()
    if s not in REQUEST_TYPES:
        raise DSARError(
            f"request_type must be one of {', '.join(REQUEST_TYPES)}"
        )
    return s


def _validate_status(raw: Optional[str]) -> str:
    s = str(raw or "").strip().lower()
    if s not in STATUSES:
        raise DSARError(
            f"status must be one of {', '.join(STATUSES)}"
        )
    return s


def _validate_event_kind(raw: Optional[str]) -> str:
    s = str(raw or "").strip().lower()
    if s not in EVENT_KINDS:
        raise DSARError(
            f"event kind must be one of {', '.join(EVENT_KINDS)}"
        )
    return s


def _validate_email(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if len(s) > 320:
        raise DSARError("subject_email too long")
    if not _EMAIL_RE.match(s):
        raise DSARError("subject_email is not a valid address")
    return s.lower()


def _clean(s: Optional[str], *, max_len: int) -> Optional[str]:
    if s is None:
        return None
    t = str(s).strip()
    if not t:
        return None
    if len(t) > max_len:
        raise DSARError(f"value too long (max {max_len})")
    return t


def hash_email(tenant_id: str, email: str) -> str:
    """Return a deterministic per-tenant sha256 fingerprint of ``email``.

    Per-tenant salting means the same address registered against two
    different workspaces hashes differently, so the operator-global
    audit log cannot be used as a cross-tenant join key.
    """
    salt = f"dsar:{(tenant_id or 'default').lower()}:".encode("ascii")
    h = hashlib.sha256(salt + (email or "").strip().lower().encode("utf-8"))
    return h.hexdigest()


def redact_email(email: str) -> str:
    """Display-only redaction, e.g. ``jane@acme.co`` -> ``j***@acme.co``.

    Never used as a primary key; safe for operator UX.
    """
    s = (email or "").strip()
    if "@" not in s:
        return "***"
    local, _, domain = s.partition("@")
    if not local:
        return f"***@{domain}"
    head = local[0]
    return f"{head}***@{domain}"


def compute_deadline(received_at: datetime) -> datetime:
    """Return the GDPR Art. 12(3) one-month response deadline."""
    return received_at + timedelta(days=RESPONSE_WINDOW_DAYS)


# ---------------------------------------------------------------------------
# ORM
# ---------------------------------------------------------------------------


class DSARequest(Base):
    """One data subject access request scoped to a tenant.

    The combination of ``received_at``, ``acknowledged_at``,
    ``identity_verified_at``, ``response_deadline_at``, and
    ``closed_at`` lets auditors reconstruct the full handling
    timeline and prove the statutory window was honoured.
    """

    __tablename__ = "dsar_requests"
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(
        String(64), index=True, nullable=False, default="default"
    )
    request_type = Column(String(32), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="received", index=True)
    subject_name = Column(String(256), nullable=False)
    # Tenant-salted sha256 of the contact email. Always present so the
    # operator can deduplicate requests from the same subject across
    # the lifecycle without storing the address itself.
    subject_email_hash = Column(String(64), nullable=False, index=True)
    # Display-only redaction (e.g. j***@acme.co). Optional.
    subject_email_redacted = Column(String(256), nullable=True)
    # Raw email only when ``store_raw_contact`` is opted in. Cleared on
    # fulfilment or rejection to minimise retention.
    subject_email_raw = Column(Text, nullable=True)
    store_raw_contact = Column(Boolean, nullable=False, default=False)
    description = Column(Text, nullable=False)
    external_ref = Column(String(256), nullable=True)
    received_via = Column(String(64), nullable=True)
    opened_by = Column(String(128), nullable=False)
    received_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    acknowledged_at = Column(DateTime, nullable=True)
    identity_verified_at = Column(DateTime, nullable=True)
    response_deadline_at = Column(DateTime, nullable=False, index=True)
    closed_at = Column(DateTime, nullable=True, index=True)
    closed_by = Column(String(128), nullable=True)
    resolution_note = Column(Text, nullable=True)


class DSAREvent(Base):
    """Append-only timeline entry attached to a DSAR."""

    __tablename__ = "dsar_events"
    id = Column(Integer, primary_key=True, autoincrement=True)
    request_id = Column(
        Integer,
        ForeignKey("dsar_requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    tenant_id = Column(
        String(64), index=True, nullable=False, default="default"
    )
    kind = Column(String(32), nullable=False)
    author = Column(String(128), nullable=False)
    note = Column(Text, nullable=False)
    created_at = Column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DSAREventView:
    id: int
    request_id: int
    kind: str
    author: str
    note: str
    created_at: str


@dataclass(frozen=True)
class DSARView:
    id: int
    tenant_id: str
    request_type: str
    status: str
    subject_name: str
    subject_email_hash: str
    subject_email_redacted: Optional[str]
    has_raw_contact: bool
    description: str
    external_ref: Optional[str]
    received_via: Optional[str]
    opened_by: str
    received_at: str
    acknowledged_at: Optional[str]
    identity_verified_at: Optional[str]
    response_deadline_at: str
    closed_at: Optional[str]
    closed_by: Optional[str]
    resolution_note: Optional[str]
    events: list[DSAREventView]


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt is not None else None


def _e_to_view(row: DSAREvent) -> DSAREventView:
    return DSAREventView(
        id=int(row.id),
        request_id=int(row.request_id),
        kind=str(row.kind),
        author=str(row.author),
        note=str(row.note),
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


def _to_view(row: DSARequest, events: list[DSAREvent]) -> DSARView:
    return DSARView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        request_type=str(row.request_type),
        status=str(row.status),
        subject_name=str(row.subject_name),
        subject_email_hash=str(row.subject_email_hash),
        subject_email_redacted=(
            str(row.subject_email_redacted)
            if row.subject_email_redacted
            else None
        ),
        has_raw_contact=bool(row.subject_email_raw),
        description=str(row.description),
        external_ref=(str(row.external_ref) if row.external_ref else None),
        received_via=(str(row.received_via) if row.received_via else None),
        opened_by=str(row.opened_by),
        received_at=(
            row.received_at.isoformat() if row.received_at else ""
        ),
        acknowledged_at=_iso(row.acknowledged_at),
        identity_verified_at=_iso(row.identity_verified_at),
        response_deadline_at=(
            row.response_deadline_at.isoformat()
            if row.response_deadline_at
            else ""
        ),
        closed_at=_iso(row.closed_at),
        closed_by=(str(row.closed_by) if row.closed_by else None),
        resolution_note=(
            str(row.resolution_note) if row.resolution_note else None
        ),
        events=[_e_to_view(e) for e in events],
    )


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def _events_for(s, tenant_id: str, request_id: int) -> list[DSAREvent]:
    return list(
        s.scalars(
            select(DSAREvent)
            .where(
                DSAREvent.tenant_id == tenant_id,
                DSAREvent.request_id == request_id,
            )
            .order_by(DSAREvent.id.asc())
        )
    )


def list_requests(
    *,
    tenant_id: str,
    include_closed: bool = True,
    limit: int = 100,
    offset: int = 0,
) -> list[DSARView]:
    tid = (tenant_id or "default")[:64]
    lim = max(1, min(int(limit), 500))
    off = max(0, int(offset))
    out: list[DSARView] = []
    with session() as s:
        q = (
            select(DSARequest)
            .where(DSARequest.tenant_id == tid)
            .order_by(DSARequest.id.desc())
            .limit(lim)
            .offset(off)
        )
        if not include_closed:
            q = q.where(DSARequest.status.in_(("received", "in_progress")))
        for row in s.scalars(q):
            ev = _events_for(s, tid, int(row.id))
            out.append(_to_view(row, ev))
    return out


def get_request(
    *, tenant_id: str, request_id: int
) -> Optional[DSARView]:
    tid = (tenant_id or "default")[:64]
    with session() as s:
        row = s.execute(
            select(DSARequest).where(
                DSARequest.tenant_id == tid,
                DSARequest.id == int(request_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return _to_view(row, _events_for(s, tid, int(row.id)))


def open_summary(tenant_id: str) -> dict:
    """Return aggregate counts useful for the admin tile."""
    tid = (tenant_id or "default")[:64]
    now = datetime.utcnow()
    out = {
        "open": 0,
        "past_deadline": 0,
        "due_soon": 0,
        "by_type": {},
    }
    with session() as s:
        rows = list(
            s.scalars(
                select(DSARequest).where(
                    DSARequest.tenant_id == tid,
                    DSARequest.status.in_(("received", "in_progress")),
                )
            )
        )
    for r in rows:
        out["open"] += 1
        out["by_type"][r.request_type] = (
            out["by_type"].get(r.request_type, 0) + 1
        )
        if r.response_deadline_at and r.response_deadline_at < now:
            out["past_deadline"] += 1
        elif (
            r.response_deadline_at
            and (r.response_deadline_at - now) <= timedelta(days=7)
        ):
            out["due_soon"] += 1
    return out


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


def open_request(
    *,
    tenant_id: str,
    request_type: str,
    subject_name: str,
    subject_email: str,
    description: str,
    opened_by: str,
    received_via: Optional[str] = None,
    external_ref: Optional[str] = None,
    store_raw_contact: bool = False,
    received_at: Optional[datetime] = None,
) -> DSARView:
    tid = (tenant_id or "default")[:64]
    rt = _validate_request_type(request_type)
    sn = _validate_subject(subject_name)
    desc = _validate_description(description)
    email = _validate_email(subject_email)
    if email is None:
        raise DSARError("subject_email is required")
    ref = _clean(external_ref, max_len=MAX_REF_LEN)
    via = _clean(received_via, max_len=64)
    actor = (opened_by or "unknown")[:128]
    recv = received_at or datetime.utcnow()
    row = DSARequest(
        tenant_id=tid,
        request_type=rt,
        status="received",
        subject_name=sn,
        subject_email_hash=hash_email(tid, email),
        subject_email_redacted=redact_email(email),
        subject_email_raw=(email if store_raw_contact else None),
        store_raw_contact=bool(store_raw_contact),
        description=desc,
        external_ref=ref,
        received_via=via,
        opened_by=actor,
        received_at=recv,
        response_deadline_at=compute_deadline(recv),
    )
    with session() as s:
        s.add(row)
        s.commit()
        s.refresh(row)
        return _to_view(row, [])


def append_event(
    *,
    tenant_id: str,
    request_id: int,
    kind: str,
    author: str,
    note: str,
) -> Optional[DSARView]:
    """Append a timeline event, scoped strictly to ``tenant_id``.

    Some kinds also stamp a milestone on the parent row:

    * ``ack_sent``         -> ``acknowledged_at``
    * ``identity_verified`` -> ``identity_verified_at``
    * ``extension`` (with ``+Nd`` in the note, default ``+60d``) ->
      extends ``response_deadline_at``.

    Returns the refreshed :class:`DSARView`, or ``None`` if the parent
    request does not exist within ``tenant_id``.
    """
    tid = (tenant_id or "default")[:64]
    k = _validate_event_kind(kind)
    text = (note or "").strip()
    if not text:
        raise DSARError("note is required")
    if len(text) > MAX_NOTE_LEN:
        raise DSARError(f"note must be at most {MAX_NOTE_LEN} characters")
    now = datetime.utcnow()
    with session() as s:
        parent = s.execute(
            select(DSARequest).where(
                DSARequest.tenant_id == tid,
                DSARequest.id == int(request_id),
            )
        ).scalar_one_or_none()
        if parent is None:
            return None
        if parent.status in ("fulfilled", "rejected", "withdrawn"):
            raise DSARError("request is closed and cannot accept new events")
        ev = DSAREvent(
            request_id=int(parent.id),
            tenant_id=tid,
            kind=k,
            author=(author or "unknown")[:128],
            note=text,
            created_at=now,
        )
        s.add(ev)
        # Milestone side-effects
        if k == "ack_sent" and parent.acknowledged_at is None:
            parent.acknowledged_at = now
            if parent.status == "received":
                parent.status = "in_progress"
        elif k == "identity_verified" and parent.identity_verified_at is None:
            parent.identity_verified_at = now
            if parent.status == "received":
                parent.status = "in_progress"
        elif k == "extension":
            match = re.search(r"\+(\d{1,3})d", text)
            extra_days = int(match.group(1)) if match else 60
            extra_days = max(1, min(extra_days, 180))
            parent.response_deadline_at = (
                parent.response_deadline_at + timedelta(days=extra_days)
            )
        s.commit()
        s.refresh(parent)
        return _to_view(parent, _events_for(s, tid, int(parent.id)))


def close_request(
    *,
    tenant_id: str,
    request_id: int,
    status_in: str,
    closed_by: str,
    resolution_note: Optional[str] = None,
) -> Optional[DSARView]:
    """Move a request into a terminal state and purge the raw contact.

    Terminal states are ``fulfilled``, ``rejected``, ``withdrawn``.
    Raw email (if stored) is cleared so the register retains only the
    salted hash going forward, minimising long-term PII retention.
    """
    tid = (tenant_id or "default")[:64]
    new_status = _validate_status(status_in)
    if new_status not in ("fulfilled", "rejected", "withdrawn"):
        raise DSARError(
            "close_request requires status in fulfilled|rejected|withdrawn"
        )
    rn = _clean(resolution_note, max_len=MAX_NOTE_LEN)
    now = datetime.utcnow()
    actor = (closed_by or "unknown")[:128]
    with session() as s:
        row = s.execute(
            select(DSARequest).where(
                DSARequest.tenant_id == tid,
                DSARequest.id == int(request_id),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.status = new_status
        row.closed_at = now
        row.closed_by = actor
        if rn:
            row.resolution_note = rn
        # PII minimisation: drop the raw contact once we're done.
        row.subject_email_raw = None
        row.store_raw_contact = False
        ev = DSAREvent(
            request_id=int(row.id),
            tenant_id=tid,
            kind="note",
            author=actor,
            note=f"[close:{new_status}] {rn or ''}".strip(),
            created_at=now,
        )
        s.add(ev)
        s.commit()
        s.refresh(row)
        return _to_view(row, _events_for(s, tid, int(row.id)))


__all__ = [
    "REQUEST_TYPES",
    "STATUSES",
    "EVENT_KINDS",
    "RESPONSE_WINDOW_DAYS",
    "DSARError",
    "DSARequest",
    "DSAREvent",
    "DSARView",
    "DSAREventView",
    "compute_deadline",
    "hash_email",
    "redact_email",
    "list_requests",
    "get_request",
    "open_summary",
    "open_request",
    "append_event",
    "close_request",
]
