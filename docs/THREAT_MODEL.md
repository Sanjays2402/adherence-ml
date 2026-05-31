# Threat model

This document is a STRIDE-style review of adherence.ml as deployed in
production. It is a living document. Last reviewed alongside the trust
center release.

## Assets

- Prediction inputs (patient identifiers, dose schedules, recent adherence
  history). Treated as PHI-equivalent in regulated deployments.
- Predictions and intervention recommendations.
- API keys, OIDC client secrets, webhook HMAC secrets.
- Audit log chain.
- Model weights and training artifacts under `models/` and the MLflow
  registry.

## Trust boundaries

1. Public internet to the dashboard (`apps/web`).
2. Dashboard to the API (`services/api`) over an authenticated session
   or bearer token.
3. API to Postgres, Redis, and the inference worker.
4. API to outbound webhook subscribers (customer-controlled endpoints).
5. Customer browsers to public share links (`/r/[token]`).

Every boundary requires either an authenticated principal with a
`workspace_id` claim, an API key resolving to a tenant, or a signed
share token with explicit allowlist scope.

## STRIDE summary

| Category | Concern | Control |
|----------|---------|---------|
| Spoofing | Stolen API key replays | DB-backed keys store sha256 hashes; per-key IP allowlist; rotation tracked; last-used timestamps surface dormant keys |
| Spoofing | Forged dashboard session | Signed session cookie; configurable TTL; force-logout-all-sessions; admin TOTP gate on privileged mutations |
| Tampering | Audit log edits | Hash-chained `admin_audit_log` with chain verify endpoint and external SIEM export |
| Tampering | Webhook payload modification in transit | HMAC-SHA256 signature on every outbound delivery; replay window enforced on inbound |
| Repudiation | Operator denies an action | Every mutation writes actor, role, IP, request id, and a before/after diff to the audit chain |
| Information disclosure | Cross-tenant data leak | `workspace_id` filter on every query; dependency-level enforcement via `require_*` in `services/api/adherence_api/deps.py`; unit tests assert 403/404 on foreign tenant access |
| Information disclosure | Verbose errors leaking schema | Errors normalized through `adherence_common.errors`; only correlation id surfaces to clients |
| Denial of service | Burst on prediction endpoint | Per-key and per-workspace rate limits returning 429 with `Retry-After` and `X-RateLimit-*` headers; per-workspace monthly quotas |
| Denial of service | Large request bodies | `body_size_middleware` enforces a hard ceiling before parsing |
| Elevation of privilege | Viewer triggers admin route | Role hierarchy enforced in `require_admin` / `require_service` / `require_viewer`; scope check on DB-backed keys; admin TOTP gate on sensitive mutations |
| Elevation of privilege | SSRF via outbound webhook | URL host allowlist; private-network blocks default-on; per-workspace toggle |

## Non-goals

- Resisting a fully compromised host running the API. Encryption at rest
  is delegated to the database and object store.
- Defending customer-controlled webhook subscribers from their own
  misconfiguration. We expose delivery logs and replay so customers can
  diagnose.
- Anti-abuse for unauthenticated public share links beyond rate limits
  and a configurable expiry.

## Review cadence

- Quarterly walkthrough by the maintainer and one external reviewer.
- Out-of-band review after any incident or material architecture change.
- Findings are tracked as GitHub issues tagged `area:security` and
  surfaced on the Trust Center as remediation items until closed.
