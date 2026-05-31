"""Per-workspace legal document acceptance tracking.

Enterprise procurement asks: "Show me, per workspace, which version of
your Terms of Service and Data Processing Agreement the customer has
accepted, by whom, when, and from which IP." Without that record a
contract dispute lands on hearsay. This module owns it.

What it does
------------
* ``LegalDocument`` rows are the canonical, immutable contract versions
  the operator has published (kind in ``{tos, dpa, privacy}``). Each row
  carries an effective timestamp and a sha256 of the body so callers can
  prove byte-for-byte what they accepted. Rows are append-only; updating
  a clause means publishing a new version, not editing history.
* ``LegalAcceptance`` rows are one acceptance per (tenant, kind, version)
  by a specific principal, recording the actor, IP, and user-agent at
  the time. Composite unique key prevents double-counting.
* Helpers compute the *current required* version per kind (the most
  recent published, effective in the past) and the *outstanding* set
  for a tenant (current required minus what they have accepted).

How enforcement uses it
-----------------------
``LegalAcceptanceMiddleware`` consults :func:`outstanding_kinds` on
every mutating request. If the tenant has not accepted the current TOS
or DPA, the request is rejected with HTTP 451 ("Unavailable For Legal
Reasons") and a structured body describing what to accept and where.
Read paths, health, metrics, GDPR data exit, SSO sign-in, and the
``/v1/legal`` endpoints themselves are exempt so a stuck workspace can
still get its data out and accept the document.

Strictly tenant-scoped: a workspace can only see and record its own
acceptances. Documents are global (operator-managed) but acceptances
are partitioned by ``tenant_id``.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    desc,
    select,
)
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

# Document kinds we track. Add new ones here when procurement demands
# a new artefact (e.g. ``baa`` for HIPAA business associate agreement).
KINDS: frozenset[str] = frozenset({"tos", "dpa", "privacy"})

# Kinds that gate mutating traffic. ``privacy`` is informational only:
# regulators expect it to be public, not click-wrapped per tenant, so
# we record acceptance when offered but never block on it.
GATING_KINDS: frozenset[str] = frozenset({"tos", "dpa"})


class LegalDocument(Base):
    """One published version of a legal document.

    Append-only by convention: the API never updates or deletes rows.
    Identity is ``(kind, version)``; ``sha256`` lets a verifier prove
    the body has not silently changed under a previously-accepted
    version label.
    """

    __tablename__ = "legal_documents"
    __table_args__ = (
        UniqueConstraint("kind", "version", name="uq_legal_doc_kind_version"),
        Index("ix_legal_doc_kind_effective", "kind", "effective_at"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    kind = Column(String(16), nullable=False)
    version = Column(String(32), nullable=False)
    title = Column(String(255), nullable=False)
    body = Column(Text, nullable=False)
    sha256 = Column(String(64), nullable=False)
    effective_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by = Column(String(128), nullable=True)


class LegalAcceptance(Base):
    """One acceptance event by a specific principal in a tenant.

    Unique on ``(tenant_id, kind, version, subject)`` so re-clicking
    "Accept" does not inflate the count, but a different subject in
    the same workspace produces its own row (audit trail of every
    individual who accepted).
    """

    __tablename__ = "legal_acceptances"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "kind", "version", "subject",
            name="uq_legal_acceptance",
        ),
        Index("ix_legal_acceptance_tenant_kind", "tenant_id", "kind"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), index=True, nullable=False, default="default")
    kind = Column(String(16), nullable=False)
    version = Column(String(32), nullable=False)
    sha256 = Column(String(64), nullable=False)
    subject = Column(String(128), nullable=False)
    subject_role = Column(String(16), nullable=False)
    accepted_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    ip = Column(String(64), nullable=True)
    user_agent = Column(String(512), nullable=True)
    request_id = Column(String(32), nullable=True)


# ---------------------------------------------------------------------------
# Views (frozen dataclasses returned to routes/tests; ORM rows stay private)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DocumentView:
    id: int
    kind: str
    version: str
    title: str
    sha256: str
    effective_at: datetime
    created_at: datetime
    created_by: Optional[str]
    body: Optional[str] = None


@dataclass(frozen=True)
class AcceptanceView:
    id: int
    tenant_id: str
    kind: str
    version: str
    sha256: str
    subject: str
    subject_role: str
    accepted_at: datetime
    ip: Optional[str]
    user_agent: Optional[str]
    request_id: Optional[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def normalise_kind(kind: str) -> str:
    k = (kind or "").strip().lower()
    if k not in KINDS:
        raise ValueError(
            f"invalid legal document kind {kind!r}; expected one of {sorted(KINDS)}"
        )
    return k


def normalise_version(version: str) -> str:
    v = (version or "").strip()
    if not v or len(v) > 32:
        raise ValueError("version must be a non-empty string up to 32 chars")
    return v


def hash_body(body: str) -> str:
    return hashlib.sha256((body or "").encode("utf-8")).hexdigest()


class DuplicateDocument(Exception):
    """Raised when a (kind, version) pair already exists."""


class UnknownDocument(Exception):
    """Raised when accepting a (kind, version) that was never published."""


class DocumentMismatch(Exception):
    """Raised when sha256 supplied at accept time differs from stored row."""


# ---------------------------------------------------------------------------
# Document CRUD (operator/admin plane; never tenant-scoped)
# ---------------------------------------------------------------------------


def publish_document(
    *,
    kind: str,
    version: str,
    title: str,
    body: str,
    effective_at: Optional[datetime] = None,
    created_by: Optional[str] = None,
) -> DocumentView:
    """Insert a new published version. Raise :class:`DuplicateDocument`
    if ``(kind, version)`` already exists.
    """
    k = normalise_kind(kind)
    v = normalise_version(version)
    if not title or len(title) > 255:
        raise ValueError("title must be a non-empty string up to 255 chars")
    if not body:
        raise ValueError("body must be non-empty")
    eff = effective_at or _now()
    if eff.tzinfo is not None:
        eff = eff.astimezone(timezone.utc).replace(tzinfo=None)
    digest = hash_body(body)
    try:
        with session() as s:
            row = LegalDocument(
                kind=k,
                version=v,
                title=title[:255],
                body=body,
                sha256=digest,
                effective_at=eff,
                created_by=(created_by[:128] if created_by else None),
            )
            s.add(row)
            s.commit()
            return _to_doc_view(row, include_body=True)
    except IntegrityError as exc:
        raise DuplicateDocument(f"{k} version {v!r} already published") from exc


def list_documents(
    *,
    kind: Optional[str] = None,
    include_body: bool = False,
) -> list[DocumentView]:
    """All published documents, newest effective first."""
    stmt = select(LegalDocument)
    if kind is not None:
        stmt = stmt.where(LegalDocument.kind == normalise_kind(kind))
    stmt = stmt.order_by(desc(LegalDocument.effective_at), desc(LegalDocument.id))
    with session() as s:
        rows = s.execute(stmt).scalars().all()
        return [_to_doc_view(r, include_body=include_body) for r in rows]


def get_document(kind: str, version: str) -> Optional[DocumentView]:
    k = normalise_kind(kind)
    v = normalise_version(version)
    with session() as s:
        row = s.execute(
            select(LegalDocument).where(
                LegalDocument.kind == k, LegalDocument.version == v
            )
        ).scalar_one_or_none()
        return _to_doc_view(row, include_body=True) if row else None


def current_document(kind: str, *, at: Optional[datetime] = None) -> Optional[DocumentView]:
    """The most recent published doc of ``kind`` whose effective_at is in
    the past (or equal to ``at``). Returns ``None`` if none has been
    published yet, in which case the kind is treated as not-required.
    """
    k = normalise_kind(kind)
    cutoff = at or _now()
    if cutoff.tzinfo is not None:
        cutoff = cutoff.astimezone(timezone.utc).replace(tzinfo=None)
    with session() as s:
        row = s.execute(
            select(LegalDocument)
            .where(LegalDocument.kind == k, LegalDocument.effective_at <= cutoff)
            .order_by(desc(LegalDocument.effective_at), desc(LegalDocument.id))
            .limit(1)
        ).scalar_one_or_none()
        return _to_doc_view(row, include_body=True) if row else None


# ---------------------------------------------------------------------------
# Acceptance (strictly tenant-scoped)
# ---------------------------------------------------------------------------


def record_acceptance(
    *,
    tenant_id: str,
    kind: str,
    version: str,
    subject: str,
    subject_role: str,
    sha256: Optional[str] = None,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    request_id: Optional[str] = None,
) -> AcceptanceView:
    """Record one acceptance event. Idempotent on the unique key: a
    repeated accept by the same subject for the same (kind, version)
    returns the existing row instead of erroring.

    Raises :class:`UnknownDocument` if the (kind, version) pair was
    never published, or :class:`DocumentMismatch` if the caller passed
    a ``sha256`` that does not match the stored body (proves the doc
    has not silently changed under the same version label).
    """
    k = normalise_kind(kind)
    v = normalise_version(version)
    sub = (subject or "").strip()[:128]
    if not sub:
        raise ValueError("subject is required to record acceptance")
    role = (subject_role or "viewer").strip().lower()[:16]
    tid = (tenant_id or "default").strip()[:64]

    doc = get_document(k, v)
    if doc is None:
        raise UnknownDocument(f"no {k} document at version {v!r}")
    if sha256 is not None and sha256.lower().strip() != doc.sha256:
        raise DocumentMismatch(
            "sha256 does not match the published document; refusing to "
            "record acceptance against a version label whose body changed"
        )

    with session() as s:
        try:
            row = LegalAcceptance(
                tenant_id=tid,
                kind=k,
                version=v,
                sha256=doc.sha256,
                subject=sub,
                subject_role=role,
                ip=(ip[:64] if ip else None),
                user_agent=(user_agent[:512] if user_agent else None),
                request_id=(request_id[:32] if request_id else None),
            )
            s.add(row)
            s.commit()
            return _to_acc_view(row)
        except IntegrityError:
            s.rollback()
            existing = s.execute(
                select(LegalAcceptance).where(
                    LegalAcceptance.tenant_id == tid,
                    LegalAcceptance.kind == k,
                    LegalAcceptance.version == v,
                    LegalAcceptance.subject == sub,
                )
            ).scalar_one()
            return _to_acc_view(existing)


def list_acceptances(
    tenant_id: str,
    *,
    kind: Optional[str] = None,
    limit: int = 200,
) -> list[AcceptanceView]:
    """All acceptance rows for one tenant, newest first.

    Strictly tenant-scoped: never returns rows from another tenant even
    if a caller passes their tenant id and queries a different one.
    """
    tid = (tenant_id or "default").strip()[:64]
    stmt = select(LegalAcceptance).where(LegalAcceptance.tenant_id == tid)
    if kind is not None:
        stmt = stmt.where(LegalAcceptance.kind == normalise_kind(kind))
    stmt = stmt.order_by(desc(LegalAcceptance.accepted_at), desc(LegalAcceptance.id))
    stmt = stmt.limit(max(1, min(int(limit), 1000)))
    with session() as s:
        rows = s.execute(stmt).scalars().all()
        return [_to_acc_view(r) for r in rows]


def tenant_has_accepted(
    tenant_id: str, kind: str, version: str
) -> bool:
    """True iff any subject in the tenant has accepted the exact
    ``(kind, version)``. Acceptance is workspace-scoped, not per-user:
    once any admin has clicked "Accept" on behalf of the company the
    workspace is unblocked.
    """
    tid = (tenant_id or "default").strip()[:64]
    k = normalise_kind(kind)
    v = normalise_version(version)
    with session() as s:
        row = s.execute(
            select(LegalAcceptance.id).where(
                LegalAcceptance.tenant_id == tid,
                LegalAcceptance.kind == k,
                LegalAcceptance.version == v,
            ).limit(1)
        ).first()
        return row is not None


def outstanding_kinds(tenant_id: str) -> list[dict]:
    """List of ``{kind, version, sha256, title, effective_at}`` that
    the tenant must accept before mutating traffic is allowed. Empty
    list means the tenant is current on every gating kind (or no doc
    has ever been published, which is the green-field default).
    """
    out: list[dict] = []
    for kind in sorted(GATING_KINDS):
        doc = current_document(kind)
        if doc is None:
            continue
        if tenant_has_accepted(tenant_id, doc.kind, doc.version):
            continue
        out.append(
            {
                "kind": doc.kind,
                "version": doc.version,
                "sha256": doc.sha256,
                "title": doc.title,
                "effective_at": doc.effective_at.isoformat(),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _to_doc_view(row: LegalDocument, *, include_body: bool = False) -> DocumentView:
    return DocumentView(
        id=int(row.id),
        kind=str(row.kind),
        version=str(row.version),
        title=str(row.title),
        sha256=str(row.sha256),
        effective_at=row.effective_at,
        created_at=row.created_at,
        created_by=(str(row.created_by) if row.created_by else None),
        body=(str(row.body) if include_body else None),
    )


def _to_acc_view(row: LegalAcceptance) -> AcceptanceView:
    return AcceptanceView(
        id=int(row.id),
        tenant_id=str(row.tenant_id),
        kind=str(row.kind),
        version=str(row.version),
        sha256=str(row.sha256),
        subject=str(row.subject),
        subject_role=str(row.subject_role),
        accepted_at=row.accepted_at,
        ip=(str(row.ip) if row.ip else None),
        user_agent=(str(row.user_agent) if row.user_agent else None),
        request_id=(str(row.request_id) if row.request_id else None),
    )


def _safe_init_for_tests() -> None:
    """Test helper: ensure tables exist on the current engine.

    Production code goes through :func:`adherence_common.db.init_db`,
    which imports this module so its tables register on ``Base.metadata``.
    """
    from adherence_common.db import _engine

    Base.metadata.create_all(_engine())
