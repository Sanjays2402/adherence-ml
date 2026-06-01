"""CAIQ Lite (Consensus Assessments Initiative Questionnaire) answers.

Enterprise procurement teams almost always send a CAIQ or SIG-Lite
spreadsheet during security review. This module owns the canonical
machine-readable answer set (one source of truth for the public trust
center, the API, and the dashboard) plus per-workspace overrides so a
buyer's account team can pin tenant-specific clarifications (eg
"Region locked to eu-west-1 by contract", "BAA on file dated
2026-04-12") without forking the canonical document.

Design
------
* The canonical question bank is code, not data: a frozen tuple of
  ``CaiqQuestion`` records keyed by stable CCM v4 control ids. Bumping
  ``SCHEMA_VERSION`` is required to remove or rename a question;
  additive changes do not require a bump.
* Per-workspace overrides live in ``caiq_overrides`` (one row per
  ``(tenant_id, question_id)``). Each override carries a normalised
  answer (yes / no / na / partial), an optional free-text note, and
  the principal who last edited it. Re-saving is idempotent.
* Reading the resolved view for a tenant returns the canonical answer
  for every question, with ``override`` populated where the tenant has
  one. Public callers never see overrides; the unauthenticated
  endpoint always returns canonical answers only.

The module does not enforce auth or audit logging. The route layer
is responsible for ``require_admin`` and ``record_admin_action`` so the
storage helpers stay reusable from CLI tools and tests.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    select,
)
from sqlalchemy.exc import SQLAlchemyError

from adherence_common.db import Base, session
from adherence_common.logging import get_logger

log = get_logger(__name__)

# Bump when a required key is removed or renamed. Additive changes do
# not require a bump. Buyers pin to this and fail loudly on break.
SCHEMA_VERSION = "1.0.0"

ANSWERS: frozenset[str] = frozenset({"yes", "no", "na", "partial"})


@dataclass(frozen=True)
class CaiqQuestion:
    """One canonical CAIQ Lite question and its vendor answer.

    ``id`` follows the CSA CCM v4 ``DOMAIN-NN`` convention so a buyer
    can cross-reference against their own questionnaire template. The
    ``answer`` is the vendor's truthful current posture; ``evidence``
    is a stable URL or repo path a reviewer can follow.
    """

    id: str
    domain: str
    question: str
    answer: str
    note: str
    evidence: str


def _q(id: str, domain: str, q: str, a: str, note: str, ev: str) -> CaiqQuestion:
    assert a in ANSWERS, f"bad canonical answer for {id}: {a!r}"
    return CaiqQuestion(id=id, domain=domain, question=q, answer=a, note=note, evidence=ev)


# Canonical question bank. Short, truthful, and verifiable from the
# repo. Adding a new question is additive; renaming or removing one
# bumps SCHEMA_VERSION. Keep grouped by CCM v4 domain so the UI can
# render a clean two-column layout without re-bucketing.
_REPO = "https://github.com/Sanjays2402/adherence-ml"
_TRUST = "https://adherence.ml/trust"

_QUESTIONS: tuple[CaiqQuestion, ...] = (
    # Audit Assurance & Compliance
    _q("AAC-01", "Audit & Compliance",
       "Is an independent third-party audit performed (SOC 2, ISO 27001) and made available under NDA?",
       "partial", "SOC 2 Type 2 and ISO 27001 in progress; HIPAA BAA and GDPR DPA available on request.",
       f"{_TRUST}#attestations"),
    _q("AAC-02", "Audit & Compliance",
       "Are tamper-evident audit logs maintained for administrative actions?",
       "yes", "Hash-chained admin_audit_log with per-row chain hash and replay verification.",
       f"{_REPO}/blob/main/packages/common/adherence_common/admin_audit_chain.py"),

    # Identity & Access Management
    _q("IAM-01", "Identity & Access",
       "Is single sign-on (SAML 2.0 or OIDC) supported for workforce identity?",
       "yes", "OIDC and SAML supported; per-workspace enforce-SSO toggle with break-glass allowlist.",
       f"{_REPO}/blob/main/services/api/adherence_api/routes/sso.py"),
    _q("IAM-02", "Identity & Access",
       "Is multi-factor authentication available for administrative actions?",
       "yes", "TOTP step-up gates sensitive admin endpoints; per-tenant policy configurable.",
       f"{_REPO}/blob/main/packages/common/adherence_common/mfa.py"),
    _q("IAM-03", "Identity & Access",
       "Is role-based access control enforced server-side on every API route?",
       "yes", "Roles: owner, admin, member, viewer; enforced via FastAPI dependencies on every router.",
       f"{_REPO}/blob/main/packages/common/adherence_common/auth.py"),
    _q("IAM-04", "Identity & Access",
       "Are API keys scoped, rotatable, and revocable with last-used timestamps?",
       "yes", "Per-key scopes (read:runs, write:runs, admin), rotation, revoke, last-used tracking.",
       f"{_REPO}/blob/main/packages/common/adherence_common/api_keys.py"),
    _q("IAM-05", "Identity & Access",
       "Is SCIM 2.0 user and group provisioning supported?",
       "yes", "SCIM 2.0 Users and Groups endpoints with per-tenant bearer authentication.",
       f"{_REPO}/blob/main/services/api/adherence_api/routes/scim.py"),

    # Data Security & Privacy
    _q("DSP-01", "Data Security",
       "Is customer data encrypted at rest with AES-256 or equivalent?",
       "yes", "AES-256 via AWS KMS for managed Postgres, object storage, and backups.",
       f"{_TRUST}#at-rest"),
    _q("DSP-02", "Data Security",
       "Is customer data encrypted in transit with TLS 1.2 or higher?",
       "yes", "TLS 1.2+ enforced end-to-end via Cloudflare edge and origin policy.",
       f"{_TRUST}#transport"),
    _q("DSP-03", "Data Security",
       "Are customer-managed encryption keys (BYOK / CMK) available on Enterprise plans?",
       "partial", "Customer-isolated CMKs available on Enterprise plan via AWS KMS grant.",
       f"{_TRUST}#cmk"),
    _q("DSP-04", "Data Security",
       "Is multi-tenant data isolation enforced at the query layer?",
       "yes", "Every persisted row carries tenant_id; FastAPI deps require tenant context on every query.",
       f"{_REPO}/blob/main/services/api/adherence_api/deps.py"),
    _q("DSP-05", "Data Security",
       "Are GDPR data subject export and hard-delete requests self-service?",
       "yes", "Workspace-wide JSON/CSV/ZIP export and confirmed hard-delete with owner step-up.",
       f"{_REPO}/blob/main/services/api/adherence_api/routes/gdpr.py"),
    _q("DSP-06", "Data Security",
       "Are personally identifiable data fields configurable for redaction?",
       "yes", "Per-tenant PII policy; outbound webhooks and audit details scrubbed before egress.",
       f"{_REPO}/blob/main/packages/common/adherence_common/pii_policy.py"),

    # Business Continuity
    _q("BCR-01", "Business Continuity",
       "Are encrypted backups retained off-region with a documented RPO and RTO?",
       "yes", "Primary us-west-2, backup us-east-1; RPO 1 hour, RTO 4 hours.",
       f"{_TRUST}#bcdr"),
    _q("BCR-02", "Business Continuity",
       "Is incident notification provided within 72 hours of confirmed breach?",
       "yes", "72-hour notification SLA documented in SECURITY.md and the public trust manifest.",
       f"{_REPO}/blob/main/SECURITY.md"),

    # Threat & Vulnerability Management
    _q("TVM-01", "Threat & Vulnerability",
       "Is a documented vulnerability disclosure program with a security.txt contact maintained?",
       "yes", "RFC 9116 security.txt at /.well-known/security.txt with 2-business-day ack SLA.",
       f"{_REPO}/blob/main/SECURITY.md"),
    _q("TVM-02", "Threat & Vulnerability",
       "Is a current software bill of materials (SBOM) published?",
       "yes", "CycloneDX 1.5 SBOM at /.well-known/sbom.json regenerated on every release.",
       f"{_REPO}/blob/main/packages/common/adherence_common/sbom.py"),

    # Supply Chain
    _q("STA-01", "Supply Chain",
       "Is a sub-processor registry maintained with per-customer change notifications?",
       "yes", "Live registry with per-workspace acknowledgment for GDPR Art. 28(2) notice obligations.",
       f"{_REPO}/blob/main/services/api/adherence_api/routes/subprocessors.py"),

    # Logging & Monitoring
    _q("LOG-01", "Logging & Monitoring",
       "Are security-relevant events streamable to a customer SIEM?",
       "yes", "Per-tenant SIEM streaming with replay window and signed delivery envelopes.",
       f"{_REPO}/blob/main/services/api/adherence_api/routes/siem.py"),
    _q("LOG-02", "Logging & Monitoring",
       "Are request IDs propagated end-to-end and surfaced in responses?",
       "yes", "X-Request-Id stamped by middleware, propagated through traces, surfaced in errors.",
       f"{_REPO}/blob/main/packages/common/adherence_common/trace_context.py"),

    # Infrastructure & Network Security
    _q("IVS-01", "Network Security",
       "Is per-tenant IP allowlisting enforced before any business logic runs?",
       "yes", "Workspace and per-API-key IP allowlist enforced at middleware layer.",
       f"{_REPO}/blob/main/services/api/adherence_api/ip_allowlist_middleware.py"),
    _q("IVS-02", "Network Security",
       "Are outbound webhooks signed and rate-limited with a customer-controlled host allowlist?",
       "yes", "HMAC-signed outbound webhooks with retries, delivery log, replay UI, and per-tenant host allowlist.",
       f"{_REPO}/blob/main/services/api/adherence_api/routes/webhooks.py"),
)


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


class CaiqOverride(Base):
    """Per-tenant override for one CAIQ question.

    Strictly tenant-scoped via ``tenant_id``. Unique on
    ``(tenant_id, question_id)`` so re-saving an answer updates in
    place instead of inflating the row count.
    """

    __tablename__ = "caiq_overrides"
    __table_args__ = (
        UniqueConstraint("tenant_id", "question_id", name="uq_caiq_override"),
        Index("ix_caiq_override_tenant", "tenant_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    tenant_id = Column(String(64), nullable=False, default="default")
    question_id = Column(String(32), nullable=False)
    answer = Column(String(16), nullable=False)
    note = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_by = Column(String(128), nullable=True)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OverrideView:
    tenant_id: str
    question_id: str
    answer: str
    note: Optional[str]
    updated_at: datetime
    updated_by: Optional[str]


@dataclass(frozen=True)
class ResolvedAnswer:
    question: CaiqQuestion
    override: Optional[OverrideView]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class UnknownQuestion(Exception):
    """Raised when a tenant tries to override a question id we don't know."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def canonical_questions() -> tuple[CaiqQuestion, ...]:
    """Return the immutable canonical question bank."""
    return _QUESTIONS


def question_index() -> dict[str, CaiqQuestion]:
    return {q.id: q for q in _QUESTIONS}


def list_overrides(tenant_id: str) -> list[OverrideView]:
    """Return all overrides recorded for ``tenant_id``, newest first."""
    with session() as s:
        rows = list(
            s.execute(
                select(CaiqOverride)
                .where(CaiqOverride.tenant_id == tenant_id)
                .order_by(CaiqOverride.updated_at.desc())
            ).scalars()
        )
        return [_to_view(r) for r in rows]


def resolved_for_tenant(tenant_id: str) -> list[ResolvedAnswer]:
    """Canonical bank with per-tenant overrides merged in.

    Preserves canonical question order so the UI can render
    deterministically. Tenant data is never leaked across tenants
    because the SELECT is filtered server-side by ``tenant_id``.
    """
    overrides = {o.question_id: o for o in list_overrides(tenant_id)}
    return [ResolvedAnswer(question=q, override=overrides.get(q.id)) for q in _QUESTIONS]


def set_override(
    *,
    tenant_id: str,
    question_id: str,
    answer: str,
    note: Optional[str],
    updated_by: str,
) -> OverrideView:
    """Insert or update one override row. Idempotent.

    Raises :class:`UnknownQuestion` for ids not in the canonical bank
    and :class:`ValueError` for an answer outside :data:`ANSWERS`.
    """
    if question_id not in question_index():
        raise UnknownQuestion(question_id)
    a = (answer or "").strip().lower()
    if a not in ANSWERS:
        raise ValueError(f"answer must be one of {sorted(ANSWERS)}")
    note_norm: Optional[str] = None
    if note is not None:
        note_clean = note.strip()
        if note_clean:
            note_norm = note_clean[:4096]
    with session() as s:
        existing = s.execute(
            select(CaiqOverride).where(
                CaiqOverride.tenant_id == tenant_id,
                CaiqOverride.question_id == question_id,
            )
        ).scalar_one_or_none()
        if existing is None:
            row = CaiqOverride(
                tenant_id=tenant_id,
                question_id=question_id,
                answer=a,
                note=note_norm,
                updated_at=datetime.utcnow(),
                updated_by=updated_by[:128] if updated_by else None,
            )
            s.add(row)
        else:
            existing.answer = a
            existing.note = note_norm
            existing.updated_at = datetime.utcnow()
            existing.updated_by = updated_by[:128] if updated_by else None
            row = existing
        try:
            s.commit()
        except SQLAlchemyError as exc:
            s.rollback()
            log.warning("caiq_override_persist_failed", error=str(exc))
            raise
        s.refresh(row)
        return _to_view(row)


def clear_override(*, tenant_id: str, question_id: str) -> bool:
    """Delete one override. Returns ``True`` if a row was removed."""
    with session() as s:
        existing = s.execute(
            select(CaiqOverride).where(
                CaiqOverride.tenant_id == tenant_id,
                CaiqOverride.question_id == question_id,
            )
        ).scalar_one_or_none()
        if existing is None:
            return False
        s.delete(existing)
        s.commit()
        return True


def _to_view(row: CaiqOverride) -> OverrideView:
    return OverrideView(
        tenant_id=row.tenant_id,
        question_id=row.question_id,
        answer=row.answer,
        note=row.note,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


# ---------------------------------------------------------------------------
# Public manifest helpers
# ---------------------------------------------------------------------------


def canonical_manifest() -> dict:
    """Stable JSON shape served at the public endpoint.

    Never includes any per-tenant override; the public document is
    always the canonical answer set.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "framework": "CSA CAIQ v4 (Lite)",
        "question_count": len(_QUESTIONS),
        "questions": [
            {
                "id": q.id,
                "domain": q.domain,
                "question": q.question,
                "answer": q.answer,
                "note": q.note,
                "evidence": q.evidence,
            }
            for q in _QUESTIONS
        ],
    }


def resolved_manifest(tenant_id: str) -> dict:
    """Canonical manifest with overrides applied for ``tenant_id``.

    The shape matches :func:`canonical_manifest` so a buyer can diff
    the two and immediately see which answers their workspace pinned.
    """
    base = canonical_manifest()
    overrides = {o.question_id: o for o in list_overrides(tenant_id)}
    base["tenant_id"] = tenant_id
    base["override_count"] = len(overrides)
    for entry in base["questions"]:
        ov = overrides.get(entry["id"])
        if ov is None:
            entry["override"] = None
        else:
            entry["override"] = {
                "answer": ov.answer,
                "note": ov.note,
                "updated_at": ov.updated_at.isoformat(),
                "updated_by": ov.updated_by,
            }
    return base
