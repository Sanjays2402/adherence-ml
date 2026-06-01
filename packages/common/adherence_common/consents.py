"""Per-tenant data subject consent register.

Enterprise procurement (HIPAA Authorization 45 CFR 164.508, GDPR Art. 7
and Recital 42, CCPA 1798.120) requires that controllers be able to
produce, on demand, a per-data-subject record of every consent or
authorization that has been collected, the exact purposes it covers,
when it was granted, and when (and by whom) it was withdrawn. This
module is the per-workspace data store for those consent receipts.

Semantics
---------

* Strict tenant scoping: every read and write filters on ``tenant_id``;
  there is no cross-tenant code path.
* Each consent is keyed by ``(tenant_id, subject_ref, purpose)``. A
  subject may have many active purposes; granting an already-active
  consent is a no-op that bumps ``version`` and updates the lawful
  basis or notes.
* Withdrawing a consent never deletes it: the row is archived with
  ``withdrawn_at`` and ``withdrawn_by`` populated so the audit trail
  is immutable.
* ``has_active_consent(tenant_id, subject_ref, purpose, at=...)``
  is the function callers should use before any processing that
  depends on consent as the lawful basis.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import Column, DateTime, Index, Integer, String, Text, select

from adherence_common.db import Base, session


MIN_SUBJECT_LEN = 1
MAX_SUBJECT_LEN = 256
MIN_PURPOSE_LEN = 2
MAX_PURPOSE_LEN = 96
MAX_NOTES_LEN = 4096
MAX_EVIDENCE_LEN = 512

# GDPR Art. 6 lawful bases plus HIPAA-specific authorization values
# kept narrow on purpose: procurement teams want a closed vocabulary.
LAWFUL_BASES = (
    "consent",                  # GDPR 6(1)(a)
    "contract",                 # GDPR 6(1)(b)
    "legal_obligation",         # GDPR 6(1)(c)
    "vital_interests",          # GDPR 6(1)(d)
    "public_task",              # GDPR 6(1)(e)
    "legitimate_interests",     # GDPR 6(1)(f)
    "hipaa_authorization",      # 45 CFR 164.508
    "hipaa_treatment",          # 45 CFR 164.506(c)
)

# Channels we trust callers to capture. Closed vocabulary.
CAPTURE_CHANNELS = (
    "web_form",
    "paper_form",
    "verbal_recorded",
    "api",
    "import",
    "other",
)


class ConsentError(ValueError):
    """Raised when a consent input is invalid."""


def _required(s: str, *, field: str, min_len: int, max_len: int) -> str:
    if s is None:
        raise ConsentError(f"{field} is required")
    t = str(s).strip()
    if len(t) < min_len:
        raise ConsentError(f"{field} must be at least {min_len} characters")
    if len(t) > max_len:
        raise ConsentError(f"{field} must be at most {max_len} characters")
    return t


def _purpose(p: str) -> str:
    t = _required(p, field="purpose", min_len=MIN_PURPOSE_LEN, max_len=MAX_PURPOSE_LEN)
    # Normalize: lowercase, collapse spaces to dots, dot-and-alnum-only.
    norm = "".join(
        ch if (ch.isalnum() or ch in ".-_") else "."
        for ch in t.lower()
    )
    while ".." in norm:
        norm = norm.replace("..", ".")
    norm = norm.strip(".")
    if not norm:
        raise ConsentError("purpose must contain alphanumeric characters")
    if len(norm) > MAX_PURPOSE_LEN:
        norm = norm[:MAX_PURPOSE_LEN]
    return norm


def _lawful(b: str) -> str:
    t = (b or "").strip().lower()
    if t not in LAWFUL_BASES:
        raise ConsentError(
            f"lawful_basis must be one of: {', '.join(LAWFUL_BASES)}"
        )
    return t


def _channel(c: str) -> str:
    t = (c or "").strip().lower()
    if t not in CAPTURE_CHANNELS:
        raise ConsentError(
            f"capture_channel must be one of: {', '.join(CAPTURE_CHANNELS)}"
        )
    return t


def _subject_ref(s: str) -> str:
    return _required(s, field="subject_ref",
                     min_len=MIN_SUBJECT_LEN, max_len=MAX_SUBJECT_LEN)


def _subject_hash(tenant_id: str, subject_ref: str) -> str:
    """Stable, tenant-scoped, non-reversible hash for indexing/search."""
    h = hashlib.sha256()
    h.update(b"adherence-consent:v1:")
    h.update((tenant_id or "default").encode("utf-8"))
    h.update(b":")
    h.update(subject_ref.encode("utf-8"))
    return h.hexdigest()


class ConsentReceipt(Base):
    """One consent receipt, scoped to a tenant + data subject + purpose."""

    __tablename__ = "consent_receipts"
    __table_args__ = (
        Index(
            "ix_consent_tenant_subject_purpose",
            "tenant_id", "subject_hash", "purpose",
        ),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    subject_ref = Column(String(MAX_SUBJECT_LEN), nullable=False)
    subject_hash = Column(String(64), nullable=False, index=True)
    purpose = Column(String(MAX_PURPOSE_LEN), nullable=False)
    lawful_basis = Column(String(32), nullable=False, default="consent")
    capture_channel = Column(String(32), nullable=False, default="web_form")
    evidence_ref = Column(String(MAX_EVIDENCE_LEN), nullable=True)
    notes = Column(Text, nullable=True)
    version = Column(Integer, default=1, nullable=False)
    granted_by = Column(String(128), nullable=False)
    granted_at = Column(DateTime, default=datetime.utcnow,
                        nullable=False, index=True)
    updated_by = Column(String(128), nullable=True)
    updated_at = Column(DateTime, nullable=True)
    withdrawn_by = Column(String(128), nullable=True)
    withdrawn_at = Column(DateTime, nullable=True, index=True)
    withdrawal_reason = Column(String(256), nullable=True)


@dataclass(frozen=True)
class ConsentView:
    id: int
    tenant_id: str
    subject_ref: str
    subject_hash: str
    purpose: str
    lawful_basis: str
    capture_channel: str
    evidence_ref: Optional[str]
    notes: Optional[str]
    version: int
    granted_by: str
    granted_at: str
    updated_by: Optional[str]
    updated_at: Optional[str]
    withdrawn_by: Optional[str]
    withdrawn_at: Optional[str]
    withdrawal_reason: Optional[str]
    active: bool


def _to_view(row: ConsentReceipt) -> ConsentView:
    return ConsentView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        subject_ref=str(row.subject_ref),
        subject_hash=str(row.subject_hash),
        purpose=str(row.purpose),
        lawful_basis=str(row.lawful_basis or "consent"),
        capture_channel=str(row.capture_channel or "web_form"),
        evidence_ref=(str(row.evidence_ref) if row.evidence_ref else None),
        notes=(str(row.notes) if row.notes else None),
        version=int(row.version or 1),
        granted_by=str(row.granted_by),
        granted_at=row.granted_at.isoformat() if row.granted_at else "",
        updated_by=(str(row.updated_by) if row.updated_by else None),
        updated_at=(row.updated_at.isoformat() if row.updated_at else None),
        withdrawn_by=(str(row.withdrawn_by) if row.withdrawn_by else None),
        withdrawn_at=(row.withdrawn_at.isoformat() if row.withdrawn_at else None),
        withdrawal_reason=(
            str(row.withdrawal_reason) if row.withdrawal_reason else None
        ),
        active=(row.withdrawn_at is None),
    )


def grant_consent(
    *,
    tenant_id: str,
    subject_ref: str,
    purpose: str,
    lawful_basis: str,
    capture_channel: str,
    granted_by: str,
    evidence_ref: Optional[str] = None,
    notes: Optional[str] = None,
) -> ConsentView:
    tid = (tenant_id or "default")[:64]
    sref = _subject_ref(subject_ref)
    pur = _purpose(purpose)
    lb = _lawful(lawful_basis)
    ch = _channel(capture_channel)
    if evidence_ref is not None:
        evidence_ref = _required(
            evidence_ref, field="evidence_ref",
            min_len=1, max_len=MAX_EVIDENCE_LEN,
        )
    if notes is not None:
        n = str(notes)
        if len(n) > MAX_NOTES_LEN:
            raise ConsentError(
                f"notes must be at most {MAX_NOTES_LEN} characters"
            )
        notes = n
    actor = (granted_by or "unknown")[:128]
    shash = _subject_hash(tid, sref)
    with session() as db:
        existing = db.execute(
            select(ConsentReceipt).where(
                ConsentReceipt.tenant_id == tid,
                ConsentReceipt.subject_hash == shash,
                ConsentReceipt.purpose == pur,
                ConsentReceipt.withdrawn_at.is_(None),
            )
        ).scalar_one_or_none()
        now = datetime.utcnow()
        if existing is not None:
            existing.lawful_basis = lb
            existing.capture_channel = ch
            existing.evidence_ref = evidence_ref
            existing.notes = notes
            existing.version = int(existing.version or 1) + 1
            existing.updated_by = actor
            existing.updated_at = now
            db.commit()
            db.refresh(existing)
            return _to_view(existing)
        row = ConsentReceipt(
            tenant_id=tid,
            subject_ref=sref,
            subject_hash=shash,
            purpose=pur,
            lawful_basis=lb,
            capture_channel=ch,
            evidence_ref=evidence_ref,
            notes=notes,
            version=1,
            granted_by=actor,
            granted_at=now.replace(microsecond=0),
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return _to_view(row)


def withdraw_consent(
    *,
    tenant_id: str,
    consent_id: int,
    withdrawn_by: str,
    reason: Optional[str] = None,
) -> Optional[ConsentView]:
    tid = (tenant_id or "default")[:64]
    creason = None
    if reason is not None:
        r = str(reason).strip()
        if len(r) > 256:
            raise ConsentError("withdrawal reason must be at most 256 characters")
        creason = r or None
    with session() as db:
        row = db.execute(
            select(ConsentReceipt).where(
                ConsentReceipt.tenant_id == tid,
                ConsentReceipt.id == int(consent_id),
                ConsentReceipt.withdrawn_at.is_(None),
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.withdrawn_by = (withdrawn_by or "unknown")[:128]
        row.withdrawn_at = datetime.utcnow()
        row.withdrawal_reason = creason
        db.commit()
        db.refresh(row)
        return _to_view(row)


def get_consent(*, tenant_id: str, consent_id: int) -> Optional[ConsentView]:
    tid = (tenant_id or "default")[:64]
    with session() as db:
        row = db.execute(
            select(ConsentReceipt).where(
                ConsentReceipt.tenant_id == tid,
                ConsentReceipt.id == int(consent_id),
            )
        ).scalar_one_or_none()
        return _to_view(row) if row is not None else None


def list_consents(
    *,
    tenant_id: str,
    subject_ref: Optional[str] = None,
    purpose: Optional[str] = None,
    include_withdrawn: bool = False,
    limit: int = 200,
    offset: int = 0,
) -> list[ConsentView]:
    tid = (tenant_id or "default")[:64]
    with session() as db:
        q = select(ConsentReceipt).where(ConsentReceipt.tenant_id == tid)
        if subject_ref:
            sref = _subject_ref(subject_ref)
            q = q.where(ConsentReceipt.subject_hash == _subject_hash(tid, sref))
        if purpose:
            q = q.where(ConsentReceipt.purpose == _purpose(purpose))
        if not include_withdrawn:
            q = q.where(ConsentReceipt.withdrawn_at.is_(None))
        q = q.order_by(ConsentReceipt.granted_at.desc()).offset(int(offset)).limit(int(limit))
        return [_to_view(r) for r in db.execute(q).scalars().all()]


def has_active_consent(
    tenant_id: str,
    subject_ref: str,
    purpose: str,
    *,
    at: Optional[datetime] = None,
) -> bool:
    """Return True iff there is an unwithdrawn consent receipt for
    ``(tenant_id, subject_ref, purpose)`` at the given moment."""
    try:
        sref = _subject_ref(subject_ref)
        pur = _purpose(purpose)
    except ConsentError:
        return False
    tid = (tenant_id or "default")[:64]
    moment = (at or datetime.utcnow()).replace(microsecond=0)
    try:
        with session() as db:
            row = db.execute(
                select(ConsentReceipt).where(
                    ConsentReceipt.tenant_id == tid,
                    ConsentReceipt.subject_hash == _subject_hash(tid, sref),
                    ConsentReceipt.purpose == pur,
                    ConsentReceipt.withdrawn_at.is_(None),
                    ConsentReceipt.granted_at <= moment,
                )
            ).scalars().first()
            return row is not None
    except Exception:
        return False


def counts(tenant_id: str) -> dict:
    tid = (tenant_id or "default")[:64]
    with session() as db:
        rows = db.execute(
            select(ConsentReceipt).where(ConsentReceipt.tenant_id == tid)
        ).scalars().all()
        active = sum(1 for r in rows if r.withdrawn_at is None)
        withdrawn = sum(1 for r in rows if r.withdrawn_at is not None)
        purposes = sorted({str(r.purpose) for r in rows if r.withdrawn_at is None})
        subjects = len({str(r.subject_hash) for r in rows if r.withdrawn_at is None})
        return {
            "active": active,
            "withdrawn": withdrawn,
            "active_subjects": subjects,
            "active_purposes": purposes,
        }


__all__ = [
    "LAWFUL_BASES",
    "CAPTURE_CHANNELS",
    "MIN_SUBJECT_LEN",
    "MAX_SUBJECT_LEN",
    "MIN_PURPOSE_LEN",
    "MAX_PURPOSE_LEN",
    "MAX_NOTES_LEN",
    "MAX_EVIDENCE_LEN",
    "ConsentError",
    "ConsentReceipt",
    "ConsentView",
    "grant_consent",
    "withdraw_consent",
    "get_consent",
    "list_consents",
    "has_active_consent",
    "counts",
]
