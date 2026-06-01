"""Public, machine-readable trust manifest for procurement scanners.

Returns a stable JSON document that automated security questionnaires
and vendor-review scripts can ingest without needing an account, an API
key, or a screen-scrape of the marketing site. The schema is versioned;
buyers can pin to ``schema_version`` and fail loudly if a future
release breaks the contract.

Nothing here is tenant-scoped or secret. It is the same information a
buyer would receive from the security questionnaire, served from a
single source of truth so the website, the API, and the dashboard
cannot drift.

See also:
* ``apps/web/public/.well-known/security.txt`` (RFC 9116, marketing host)
* ``services/api/adherence_api/routes/well_known.py`` (API host)
* ``apps/web/app/trust`` (human-readable Trust Center)
"""
from __future__ import annotations

from typing import Any

from adherence_common.sbom import sbom_summary
from adherence_common.version import __version__

# Bump when a required key is removed or renamed. Additive changes do
# not require a bump but should be reflected in
# ``apps/web/app/trust/client.tsx`` and the README "Try it" section.
SCHEMA_VERSION = "1.0.0"

# Stable, intentionally small. Buyers pin to these.
_PRIMARY_REGION = "us-west-2"
_BACKUP_REGION = "us-east-1"
_DATA_SUBJECT_CONTACT = "privacy@adherence.ml"
_SECURITY_CONTACT = "security@adherence.ml"
_INCIDENT_CONTACT = "incidents@adherence.ml"
_STATUS_PAGE = "https://status.adherence.ml"
_TRUST_CENTER = "https://adherence.ml/trust"
_REPO = "https://github.com/Sanjays2402/adherence-ml"

# These mirror docs/SUBPROCESSORS.md. Edit both together; the
# integration test fails if the table goes empty so we cannot silently
# ship a deployment with zero declared subprocessors.
_SUBPROCESSORS: list[dict[str, str]] = [
    {
        "name": "Amazon Web Services",
        "purpose": "Primary compute, storage, managed Postgres, KMS",
        "data_categories": "All customer data at rest and in transit",
        "region": _PRIMARY_REGION,
    },
    {
        "name": "Cloudflare",
        "purpose": "Edge TLS, DDoS protection, WAF, DNS",
        "data_categories": "Request metadata, IP addresses, TLS SNI",
        "region": "Global edge",
    },
    {
        "name": "Sentry",
        "purpose": "Error monitoring (PII-scrubbed)",
        "data_categories": "Stack traces, request IDs, redacted payloads",
        "region": "us",
    },
    {
        "name": "Resend",
        "purpose": "Transactional email (invites, password reset, alerts)",
        "data_categories": "Recipient email, message body",
        "region": "us",
    },
]

# Public commitments. Each entry is verifiable from the codebase or
# from documents shipped in /trust. Keep the list short and true.
_CONTROLS: list[dict[str, Any]] = [
    {
        "id": "encryption_in_transit",
        "label": "TLS 1.2+ enforced end-to-end",
        "evidence": f"{_TRUST_CENTER}#transport",
    },
    {
        "id": "encryption_at_rest",
        "label": "AES-256 via AWS KMS for database, object storage, backups",
        "evidence": f"{_TRUST_CENTER}#at-rest",
    },
    {
        "id": "audit_log",
        "label": "Tamper-evident hash chain on admin_audit_log",
        "evidence": f"{_REPO}/blob/main/packages/common/adherence_common/admin_audit_chain.py",
    },
    {
        "id": "rbac",
        "label": "Roles: owner, admin, member, viewer; enforced at dependency layer",
        "evidence": f"{_REPO}/blob/main/packages/common/adherence_common/auth.py",
    },
    {
        "id": "sso",
        "label": "OIDC + SAML; per-workspace enforce-SSO with break-glass allowlist",
        "evidence": f"{_TRUST_CENTER}#sso",
    },
    {
        "id": "sbom",
        "label": "CycloneDX 1.5 SBOM published at /.well-known/sbom.json",
        "evidence": f"{_REPO}/blob/main/packages/common/adherence_common/sbom.py",
    },
    {
        "id": "mfa",
        "label": "TOTP step-up for sensitive admin actions",
        "evidence": f"{_TRUST_CENTER}#mfa",
    },
    {
        "id": "scim",
        "label": "SCIM 2.0 user and group provisioning",
        "evidence": f"{_REPO}/blob/main/services/api/adherence_api/routes/scim.py",
    },
    {
        "id": "data_residency",
        "label": f"Default region {_PRIMARY_REGION}; per-tenant residency hint via X-Data-Residency",
        "evidence": f"{_TRUST_CENTER}#residency",
    },
    {
        "id": "data_classification",
        "label": "Per-workspace classification (public, internal, confidential, restricted)",
        "evidence": f"{_TRUST_CENTER}#classification",
    },
    {
        "id": "gdpr_export",
        "label": "Workspace-wide JSON/CSV/ZIP export and hard-delete with confirmation",
        "evidence": f"{_REPO}/blob/main/services/api/adherence_api/routes/gdpr.py",
    },
    {
        "id": "ip_allowlist",
        "label": "Per-workspace and per-API-key IP allowlist enforced at middleware",
        "evidence": f"{_REPO}/blob/main/services/api/adherence_api/ip_allowlist_middleware.py",
    },
    {
        "id": "rate_limits",
        "label": "Per-key and per-workspace rate limits; 429 with Retry-After and X-RateLimit-* headers",
        "evidence": f"{_REPO}/blob/main/services/api/adherence_api/ratelimit_middleware.py",
    },
    {
        "id": "webhook_hmac",
        "label": "HMAC-signed outbound webhooks with retries, delivery logs, and replay UI",
        "evidence": f"{_REPO}/blob/main/services/api/adherence_api/routes/webhooks.py",
    },
    {
        "id": "vuln_disclosure",
        "label": "RFC 9116 security.txt and 2-business-day acknowledgement SLA",
        "evidence": f"{_REPO}/blob/main/SECURITY.md",
    },
]


def _sbom_manifest_block(api_base: str) -> dict[str, Any]:
    """Inline SBOM summary + canonical URL for procurement scanners.

    Wrapped in a try/except so a malformed lockfile in a downstream
    deployment can never take the trust manifest down. Buyers must
    always be able to read the manifest; the SBOM degrades gracefully.
    """
    block: dict[str, Any] = {
        "format": "CycloneDX",
        "spec_version": "1.5",
        "url": f"{api_base.rstrip('/')}/.well-known/sbom.json",
        "content_type": "application/vnd.cyclonedx+json",
    }
    try:
        summary = sbom_summary()
        block.update(
            {
                "schema_version": summary["schema_version"],
                "serial_number": summary["serial_number"],
                "total_components": summary["total_components"],
                "components_by_ecosystem": summary["components_by_ecosystem"],
                "generated_at": summary["generated_at"],
            }
        )
    except Exception as exc:  # pragma: no cover - defensive
        block["status"] = "unavailable"
        block["detail"] = type(exc).__name__
    return block


def build_manifest(
    *,
    api_base: str | None = None,
    web_base: str | None = None,
) -> dict[str, Any]:
    """Build the canonical trust manifest dict.

    Pure function. Callers MUST NOT mutate the returned dict in place;
    if you need overrides build a new dict.

    ``api_base`` and ``web_base`` let the API host advertise its own
    canonical URLs even when the deployment is white-labelled. Both
    default to the published adherence.ml hosts.
    """
    api = (api_base or "https://api.adherence.ml").rstrip("/")
    web = (web_base or "https://adherence.ml").rstrip("/")
    return {
        "schema_version": SCHEMA_VERSION,
        "product": "adherence-ml",
        "product_version": __version__,
        "vendor": {
            "legal_name": "adherence.ml",
            "trust_center": _TRUST_CENTER,
            "status_page": _STATUS_PAGE,
            "source_repository": _REPO,
        },
        "contacts": {
            "security": _SECURITY_CONTACT,
            "incidents": _INCIDENT_CONTACT,
            "data_subject_requests": _DATA_SUBJECT_CONTACT,
            "security_txt": f"{web}/.well-known/security.txt",
            "security_txt_api": f"{api}/.well-known/security.txt",
            "sbom": f"{api}/.well-known/sbom.json",
        },
        "data_residency": {
            "primary_region": _PRIMARY_REGION,
            "backup_region": _BACKUP_REGION,
            "per_tenant_hint_header": "X-Data-Residency",
        },
        "encryption": {
            "in_transit": "TLS 1.2+",
            "at_rest": "AES-256 via AWS KMS",
            "key_management": "AWS KMS with customer-isolated CMKs available on Enterprise plan",
        },
        "subprocessors": list(_SUBPROCESSORS),
        "controls": list(_CONTROLS),
        "sbom": _sbom_manifest_block(api),
        "incident_response": {
            "notification_sla_hours": 72,
            "status_page": _STATUS_PAGE,
            "contact": _INCIDENT_CONTACT,
        },
        "data_subject_rights": {
            "export": True,
            "delete": True,
            "contact": _DATA_SUBJECT_CONTACT,
            "self_service_url": f"{web}/settings/gdpr",
        },
        "compliance_attestations": {
            # Honest: don't claim certifications we don't have. Buyers
            # respect a vendor that says "in progress" more than one
            # that fakes a SOC2 logo.
            "soc2_type2": "in_progress",
            "iso_27001": "in_progress",
            "hipaa_baa": "available_on_request",
            "gdpr_dpa": "available_on_request",
        },
    }
