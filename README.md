# adherence-ml

Medication adherence risk modeling and intervention API with a Next.js admin dashboard.

## Tamper-evident admin audit chain

Every row in `admin_audit_log` is now linked to its predecessor by a sha256
`row_hash` over `(id, tenant_id, request_id, action, target, caller,
caller_role, ok, error, details, created_at, prev_hash)`. The chain is
global, append-only, and verified end-to-end. Edits, deletions, and
reorderings break the chain at the first divergence and are reported
with the offending row id and reason. SOC2 CC7.2 / ISO 27001 A.12.4.2
evidence on demand.

- Library: `packages/common/adherence_common/admin_audit_chain.py`
- Endpoint: `GET /v1/admin/audit/chain/verify?tenant=...&limit=...`
- UI: `/settings/audit-integrity` (admin)
- Test: `tests/unit/test_admin_audit_chain.py` (covers field tampering
  detection and middle-row deletion detection)

The verification call is itself recorded as an audit event
(`audit.chain.verify`), so an auditor can prove a check was run, by whom,
and what it found. Pre-existing rows from before the chain shipped retain
NULL `row_hash` / `prev_hash`; the verifier tolerates the gap and the
chain restarts at the first newly recorded row.

### Try the chain verifier

```bash
uv run uvicorn adherence_api.app:app --reload --port 8000
# in another shell
TOKEN=$(curl -s -X POST localhost:8000/v1/admin/token \
  -H 'content-type: application/json' \
  -d '{"role":"admin","tenant":"default"}' | jq -r .access_token)
curl -s -H "authorization: bearer $TOKEN" \
  localhost:8000/v1/admin/audit/chain/verify | jq .
```

Then open `http://localhost:3000/settings/audit-integrity` to verify
from the dashboard.

## Per-workspace data classification

Procurement, HIPAA, and EU healthcare reviewers want to see a concrete per-tenant sensitivity tier they can map to their own DLP, encryption, and breach-notification playbooks. This release adds that as a first-class, audit-logged workspace setting wired across the API surface.

- New table `workspace_data_classification` holds the per-tenant label (`public`, `internal`, `confidential`, `restricted`) plus a free-form justification, updated-by, and updated-at. Default when unset is `confidential`.
- `GET/PUT/DELETE /v1/workspace/data-classification` lets a workspace admin read, set, or clear the label. Writes are admin-only, MFA-gated, dry-run aware (`?dry_run=true`), and audit-logged under `workspace.data_classification.set` / `.clear` with both the new and prior label.
- Every tenant-bound response now carries `X-Data-Classification: <label>` alongside the existing `X-Data-Residency` header so security reviewers running `curl` can read the contractual tier without an extra round-trip.
- The Settings UI gains `/settings/data-classification`: a Linear-style page with the current label, contractually enforced retention floor (0 / 30 / 90 / 365 days per tier), justification, MFA-gated save, dry-run preview, and clear-pin.
- Cross-tenant isolation is proven by an integration test: pinning `acme` to `restricted` does not affect `globex`, viewers cannot write, unknown labels are rejected, and `dry_run=true` never persists.

Proven by `tests/integration/test_data_classification.py` (4 tests).

### Try it

Web UI: <http://127.0.0.1:3000/settings/data-classification>.

```bash
# Read the active label and its retention floor.
curl -s http://127.0.0.1:8000/v1/workspace/data-classification \
  -H "Authorization: Bearer $TOKEN" | jq

# Pin the workspace to restricted (PHI / PCI). Dry-run first.
curl -s -X PUT \
  'http://127.0.0.1:8000/v1/workspace/data-classification?dry_run=true' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'x-mfa-code: 123456' \
  -H 'content-type: application/json' \
  -d '{"label":"restricted","justification":"PHI under 45 CFR 164.514"}' | jq

# Check the response header on any tenant-bound call.
curl -si http://127.0.0.1:8000/v1/workspace/data-classification \
  -H "Authorization: Bearer $TOKEN" | grep -i x-data-classification
```

## Per-workspace enforce-SSO toggle

Regulated buyers (HIPAA, PCI, SOX, FedRAMP-style) require that human sign-in for their tenant go through their corporate IdP. Once enforce-SSO is on for a workspace, password and magic-link JWTs are rejected on the very next request; only OIDC-issued sessions (Okta, Azure AD, Google Workspace) and DB-backed service-account API keys may call the API. CI does not break because machine integrations stay allowed.

- `PUT /v1/workspace/sso-enforcement {require_sso, break_glass_subjects[]}` (admin + MFA, `?dry_run=true` supported, audit-logged).
- `GET /v1/workspace/sso-enforcement` returns the live policy; viewers see whether SSO is required, admins also see the break-glass list.
- Enforcement runs inside `services/api/adherence_api/deps._principal_from_headers`, so the gate bites every authenticated route without per-route changes. JWTs minted via `/v1/admin/sso/oidc/exchange` carry an `auth_method=sso` claim; `/v1/admin/token` mints stamp `password`.
- A break-glass allow-list of up to 5 subjects (JWT `sub` or API-key name) preserves a recovery path if the IdP is down. Every bypass writes `sso.enforcement.break_glass` to the admin audit log.
- Dashboard surface: <http://127.0.0.1:3000/settings/sso-enforcement> with toggle, chip-based break-glass editor, dry-run, clear, and per-change MFA.

Proven by `tests/integration/test_sso_enforcement.py`: a password token that worked seconds ago is rejected with `403 sso_required` after the toggle flips, an SSO-issued token in the same tenant still works, a sibling tenant is unaffected, and the break-glass subject bypasses the gate while landing an audit row.

### Try enforce-SSO

```bash
# Read the current policy (viewer or admin).
curl -sS http://127.0.0.1:8000/v1/workspace/sso-enforcement \
  -H 'x-api-key: <admin-key>'

# Flip it on for the tenant the caller belongs to, with a single break-glass subject.
curl -sS -X PUT 'http://127.0.0.1:8000/v1/workspace/sso-enforcement?dry_run=true' \
  -H 'x-api-key: <admin-key>' -H 'X-MFA-Code: 123456' \
  -H 'content-type: application/json' \
  -d '{"require_sso": true, "break_glass_subjects": ["sso:okta:owner@acme.com"]}'
```


## API key revocation with recorded reason

Procurement and SOC2 reviewers ask the same question for every credential a vendor ever issued: why was it killed, when, and by whom? The previous revoke path flipped a boolean and walked away, so the audit log had no forensic record of compromise vs rotation vs offboarding. This release fixes that across the schema, the API, the UI, and the audit trail.

- `DELETE /api/keys/{id}` now accepts an optional JSON body `{ "reason": "compromised" | "rotated" | "employee_offboarded" | "unused" | "vendor_offboarded" | "policy_violation" | "other", "note": "..." }`. Unknown reasons return 400; oversize notes (>280 chars) are rejected by zod.
- A second revoke of the same key returns **409 Conflict** with the original `revoked_at` and `revoked_reason` instead of pretending the call succeeded, so SOAR playbooks can detect duplicate kill attempts.
- Every outcome (success, denied, already_revoked, not_found) writes a tamper-evident entry to the dashboard audit log under action `api_key.revoke`, with actor email, IP, prefix, reason, note, and a before/after revoked flag.
- `GET /api/keys` exposes `revoke_reasons` for the dashboard plus `revoked_reason`, `revoked_at`, `revoked_by_email`, and `revoked_note` on each key view.
- The `/api-keys` page replaces the legacy `window.confirm` with an accessible modal (Escape to dismiss, focus-trapped buttons, character counter on the note). Revoked rows show the reason inline (`revoked: compromised`) and the full attribution on hover.
- Legacy callers using `revokeKey(id)` keep the boolean contract; the new typed metadata flows through `revokeKeyDetailed(id, opts)`.

Proven by `apps/web/tests/api-keys-revoke-reason.test.ts` (8 tests):

- Reason, note, actor, and timestamp are persisted and round-trip through `publicView`.
- Double-revoke returns `already_revoked` and never overwrites the first reason or timestamp.
- The legacy `revokeKey(id)` boolean still returns `true` on first call and `false` on the second.
- Notes longer than `REVOKE_NOTE_MAX` (280) are truncated, not silently rejected.
- Off-enum reasons fall back to `unspecified` instead of polluting the audit log.
- `SELECTABLE_REVOKE_REASONS` never advertises the legacy `unspecified` bucket to the dashboard.

### Try the recorded revoke

Web UI: <http://127.0.0.1:3000/api-keys>. Create a key, then click **revoke** to open the reason picker.

```bash
# Kill a leaked key and tell the audit log why.
curl -s -X DELETE http://127.0.0.1:3000/api/keys/KEY_ID \
  -H 'content-type: application/json' \
  -b "adherence_session=$SESSION_COOKIE" \
  -d '{"reason":"compromised","note":"posted in a public gist"}' | jq

# A second attempt returns 409 with the original revoke metadata.
curl -s -i -X DELETE http://127.0.0.1:3000/api/keys/KEY_ID \
  -H 'content-type: application/json' \
  -b "adherence_session=$SESSION_COOKIE" \
  -d '{"reason":"rotated"}' | head -n 1
## Step-up MFA for sensitive admin actions

Long-lived dashboard sessions are convenient but a SOC2 CC6.1 reviewer flags them the moment they realise that one stolen laptop with an unlocked browser can issue API keys, rotate secrets, transfer workspace ownership, erase the operator account, and wipe every persisted row, all without ever proving a second factor. A signed session cookie is no longer enough for those actions.

The dashboard now enforces a per-session step-up MFA window. When the caller has TOTP enrolled (or a workspace policy mandates MFA), sensitive routes require that the session was minted via 2FA or that the user has verified a TOTP code within the last 10 minutes. The check lives in `apps/web/lib/step-up.ts` and is wired through `requireDashboardAuth({ stepUp: true })` so adding it to a new route is one option flip.

Gated routes:

- `POST   /api/keys`               issue a new API key
- `DELETE /api/keys/{id}`          revoke an API key
- `POST   /api/keys/{id}/rotate`   rotate an API key secret
- `POST   /api/workspaces/{id}/transfer-ownership`  hand the owner role over
- `DELETE /api/auth/account`       hard-delete the caller's account
- `POST   /api/settings/wipe`      irreversible workspace-wide data wipe

Dry-run previews (`?dry_run=true`) intentionally do NOT require step-up: the whole point is to render the impact upfront so an operator can decide whether the action is worth the friction. Only the live, mutating call demands a fresh second factor.

The gate returns HTTP 403 with a structured body so any UI can react:

```json
{
  "error": "mfa_step_up_required",
  "code": "mfa_step_up_required",
  "detail": "this action requires a fresh second factor proof; enter your TOTP code to continue",
  "step_up": {
    "max_age_seconds": 600,
    "last_mfa_at": null,
    "totp_enrolled": true,
    "policy_requires_mfa": false,
    "verify_url": "/api/auth/2fa/step-up",
    "reason": "no_recent_mfa"
  }
}
```

The dashboard mounts `<StepUpProvider />` (in `app/layout.tsx`) and any client that calls `stepUpFetch()` instead of `fetch()` gets a transparent retry: the dialog opens, the user enters a TOTP or recovery code, `POST /api/auth/2fa/step-up` stamps the session's `last_mfa_at`, and the original request is replayed once. The api-keys console already uses it, so issuing, rotating, and revoking a key prompts inline without bouncing the user back to `/login`. Every step-up attempt (success and failure) is appended to the existing tamper-evident dashboard audit log under `auth.step_up`, and every gated denial is logged under the original action name with `reason: "mfa_step_up_required"` so a CISO can see refused attempts on the same timeline as the actions themselves.

Proven by `apps/web/tests/step-up.test.ts` (6 tests):

- Users with no TOTP enrolled and no workspace MFA policy pass through, so single-user and pre-2FA deployments are never locked out of their own console.
- TOTP-enrolled users whose session has no recent MFA proof are blocked with `no_recent_mfa`.
- A session with `last_mfa_at` inside the 10-minute window clears the gate.
- A session with `last_mfa_at` past the window is blocked again.
- `markSessionMfa` persists the new timestamp on the per-session record so subsequent reads see it.
- The denied response is HTTP 403 with `code: "mfa_step_up_required"` and the verify URL the client needs to call.

### Try it

Local dashboard: <http://127.0.0.1:3000/api-keys>. Enroll a TOTP authenticator at `/settings/security`, sign out and back in (so the session records a fresh `last_mfa_at`), then wait 10 minutes or open the browser devtools and `document.cookie`-clear the timestamp. Click "issue key" and the step-up dialog opens. Enter the current 6-digit code, the request retries automatically, and the key issues with the dialog dismissed.

```bash
# refresh the step-up window on the current session
curl -sS -X POST http://127.0.0.1:3000/api/auth/2fa/step-up \
  -H 'content-type: application/json' \
  --cookie 'adh_session=...' \
  -d '{"code":"123456"}'
# => { "ok": true, "last_mfa_at": 1717100000000, "max_age_seconds": 600, ... }

# without a fresh proof, issuing a key now refuses with 403 mfa_step_up_required
curl -sS -X POST http://127.0.0.1:3000/api/keys \
  -H 'content-type: application/json' \
  --cookie 'adh_session=...' \
  -d '{"name":"prod-readonly","scopes":["read:runs"],"ttl_days":30}'
```

## Catalog-aligned webhook subscriptions

The published webhook event catalog already advertised six stable event types, but `POST /api/webhooks` and `POST /v1/webhooks` only validated two of them, so an enterprise integrator who pasted `intervention.recommended` from the procurement-facing catalog page got a 422. The dashboard checkbox list was hard-coded to the same two events, so customers could not subscribe to risk interventions, member invites, or API-key rotations even though the catalog promised those payloads.

The webhook subscription surface now derives directly from `STABLE_EVENT_TYPES` in `apps/web/lib/webhook-catalog.ts`. Both the dashboard route (`/api/webhooks`) and the key-authenticated route (`/v1/webhooks`) accept every stable catalog event and reject every unknown or beta event with a 422. The `/workspace/webhooks` checkbox list shows the full set. Two existing routes now actually emit catalog events end-to-end: `POST /api/keys/{id}/rotate` fires `api_key.rotated`, and `POST /api/workspaces/{id}/invites` fires `member.invited`, with full HMAC signatures and the standard retry/replay pipeline.

Proven by `apps/web/tests/webhook-event-catalog-subscribe.test.ts` (4 tests):

- The subscribable surface equals the stable catalog exactly, so adding an event to the catalog opens it for subscription with no other change.
- Subscribing to a newly-promoted event (`intervention.high_risk`, `api_key.rotated`) persists the subscription instead of falling back to a default.
- Unknown event names are silently dropped from the persisted subscription so receivers never see a phantom event type they cannot decode.
- Beta catalog events (`drift.detected`) are still rejected from the subscribable surface until promoted to stable.

### Try it

Local dashboard: <http://127.0.0.1:3000/workspace/webhooks>. Sign in at `/dashboard`, click **new endpoint**, tick `intervention.high_risk` and `api_key.rotated`, copy the one-time signing secret, then rotate any API key from `/keys` to watch the `api_key.rotated` delivery land in the deliveries table below.

```bash
# what the public catalog advertises
curl -s http://127.0.0.1:3000/api/webhooks/event-catalog | jq '.stable_event_types'

# subscribe an endpoint to a catalog event that used to be rejected
curl -sS -X POST http://127.0.0.1:3000/api/webhooks \
  -H 'content-type: application/json' \
  --cookie 'adh_session=...' \
  -d '{"name":"care-ops","url":"https://example.com/hook","events":["intervention.high_risk","api_key.rotated","member.invited"]}'
```

## Workspace API-key max lifetime policy

Workspace owners can now cap the maximum TTL of any API key issued or rotated for the deployment. SOC2 CC6.1 reviews routinely flag "keys that never expire" as a finding; this policy makes that impossible to ship by mistake. When the cap is set to N days, every `POST /api/keys` call must include `ttl_days` such that `0 < ttl_days <= N`. Requests that ask for no expiry or for a longer TTL are refused with HTTP 422 and a structured `code` (`api_key_ttl_required` or `api_key_ttl_exceeds_cap`). Key rotation re-stamps `expires_at` from "now", so periodic rotation IS the renewal action and a key can never outlive the cap.

The cap lives on `WorkspaceSecurityPolicy.api_key_max_ttl_days` (owner-only write, RBAC-checked, dry-run aware, audited via `workspace.policy.update`). API keys in this codebase live in a single workspace-agnostic store, so the enforced cap is the strictest one across every workspace the deployment hosts (the cross-tenant safe choice).

Proven by `apps/web/tests/workspace-api-key-ttl-cap.test.ts`:

- The policy field round-trips and only owners can write it (RBAC).
- `effectiveApiKeyMaxTtlDays` picks the strictest cap across workspaces.
- `POST /api/keys` without `ttl_days` is rejected when a cap is in force.
- `POST /api/keys` with `ttl_days` greater than the cap is rejected.
- `POST /api/keys` with a TTL inside the cap succeeds and the issued key carries a real `expires_at`.
- With no cap configured, legacy no-expiry keys still work (back-compat).
- Rotation re-stamps `expires_at` to `now + cap` when a cap is supplied.

### Try the API-key TTL cap

Web UI: <http://127.0.0.1:3000/workspace/security> (the *API key max lifetime* card).

```bash
# Set a 90-day cap on this workspace (owner session required).
curl -s -X PUT "http://127.0.0.1:3000/api/workspaces/$WS_ID/policy" \
  -H "content-type: application/json" \
  -b "adherence_session=$SESSION_COOKIE" \
  -d '{"session_max_age_minutes":null,"require_mfa":false,"api_key_max_ttl_days":90}'

# This call is now refused (HTTP 422, code=api_key_ttl_required).
curl -s -X POST http://127.0.0.1:3000/api/keys \
  -H "content-type: application/json" \
  -d '{"name":"forever"}'

# This call succeeds: TTL fits inside the cap.
curl -s -X POST http://127.0.0.1:3000/api/keys \
  -H "content-type: application/json" \
  -d '{"name":"compliant","ttl_days":30}'
```

## Workspace ownership transfer

Workspace owners can now hand the workspace to another existing member instead of being stranded when they leave the company. The account-erasure flow has long told sole owners to "transfer ownership before deleting your account"; this endpoint and UI are what makes that possible.

`POST /api/workspaces/{id}/transfer-ownership` is owner-only. The body takes `{ target_user_id, demote_to? }` where `demote_to` is `editor` (default) or `viewer`. The route refuses cross-tenant targets (`not_found`), non-owner callers (`forbidden`), and transfer-to-self (`400`). It supports `?dry_run=true` and writes a tamper-evident audit row (`workspace.ownership.transfer`) on every success or denial, including the previous owner, the new owner, and the demoted role.

The **Members** card in `/workspace` shows a transfer-ownership button beside the trash icon for each non-owner member (owners only). The browser confirms the demotion before the request is sent.

Proven by `apps/web/tests/workspace-transfer-ownership.test.ts`:

- Roles flip and persist (target becomes `owner`, caller becomes `editor`).
- Transfer-to-self is refused.
- An editor cannot hand the workspace to anyone (cross-role denial).
- A target who is not a member of this workspace is refused (cross-tenant denial); the other workspace is untouched.
- `demote_to: "owner"` is rejected (`invalid_role`).

### Try ownership transfer

Web UI: <http://127.0.0.1:3000/workspace> (Members card, arrows-left-right button).

```bash
# Dry-run: see who would become owner without committing.
curl -s -X POST "http://127.0.0.1:3000/api/workspaces/$WS_ID/transfer-ownership?dry_run=true" \
  -H "content-type: application/json" \
  -b "adherence_session=$SESSION_COOKIE" \
  -d '{"target_user_id":"u_bob","demote_to":"editor"}'

# Commit the transfer.
curl -s -X POST "http://127.0.0.1:3000/api/workspaces/$WS_ID/transfer-ownership" \
  -H "content-type: application/json" \
  -b "adherence_session=$SESSION_COOKIE" \
  -d '{"target_user_id":"u_bob"}'
```

## Per-subscription webhook delivery health

Operators previously had to page through individual `webhook_deliveries` rows (or trip the circuit breaker) to know whether an outbound subscription was healthy. The API now exposes a rolling-window health summary so a workspace admin can answer "is this receiver healthy right now" with a single request, without leaking another tenant's numbers.

`GET /v1/webhooks/outbound/subscriptions/{name}/health` returns, for the calling tenant only: total / success / failed / dead_letter / queued / blocked counts within `window_minutes` (default 1440, max 7 days), `success_rate` (1.0 when there has been no traffic, so quiet receivers are not flagged red), p50 + p95 latency over successful attempts, last status code, last attempt time, last success time, current `consecutive_failures`, and the active / disabled state from the subscription row itself. A name that belongs to another workspace returns 404, not zeros, so the endpoint cannot be used to enumerate cross-tenant subscriptions.

Proven by `tests/integration/test_outbound_subscription_health.py`:

- Counts only deliveries created within `window_minutes` (ancient rows are excluded).
- `success_rate = success / total`, with 1.0 when total is 0 so idle receivers stay green.
- p95 is computed over successful latencies via nearest-rank.
- Tenant A asking for tenant B's subscription name gets 404, never another tenant's numbers.
- Unknown subscription returns 404 (no existence oracle).
- All-time `last_attempt_at` and `last_success_at` still surface even when the window is empty.

### Try delivery health

Local API: <http://127.0.0.1:8000>.

```bash
# Default 24h window
curl -s http://127.0.0.1:8000/v1/webhooks/outbound/subscriptions/prod-hook/health \
  -H "x-api-key: $ADMIN_KEY"

# Tight 15-minute window for an active incident
curl -s "http://127.0.0.1:8000/v1/webhooks/outbound/subscriptions/prod-hook/health?window_minutes=15" \
  -H "x-api-key: $ADMIN_KEY"
```

Response shape:

```json
{
  "name": "prod-hook",
  "subscription_id": 42,
  "window_minutes": 1440,
  "window_started_at": "2026-05-30T16:00:00",
  "total": 128,
  "success": 124,
  "failed": 3,
  "dead_letter": 1,
  "queued": 0,
  "blocked": 0,
  "success_rate": 0.9688,
  "p50_latency_ms": 42.0,
  "p95_latency_ms": 310.0,
  "last_status_code": 200,
  "last_state": "success",
  "last_error": null,
  "last_attempt_at": "2026-05-31T22:14:09",
  "last_success_at": "2026-05-31T22:14:09",
  "consecutive_failures": 0,
  "active": true,
  "disabled_at": null,
  "disabled_reason": null
}
```

## Canonical webhook event catalog

Webhook subscriptions historically accepted any free-form event name, so a typo in `event_types` silently produced a subscription that would never fire and procurement reviewers had no way to introspect what events the API actually emits. The new catalog lives in `packages/common/adherence_common/webhook_events.py` (mirrored in `apps/web/lib/webhook-catalog.ts`) and is enforced everywhere: `PUT /v1/webhooks/outbound/subscriptions` and `POST /v1/webhooks/outbound/test-send` reject any `event_type` not in the catalog with `400 unknown_event_type`, and `dispatch()` emits a structured warning if a caller fires an off-catalog event. Customers and procurement teams read the full contract (description, stability, schema, example payload) at `GET /v1/webhooks/event-catalog` or in the dashboard at `/workspace/webhooks/catalog`.

Proven by `tests/unit/test_webhook_event_catalog.py` (5 tests):

- Every shipped event type (`test.ping`, `intervention.recommended`, `run.created`, `drift.detected`, `api_key.rotated`, `member.invited`) is in the catalog and carries a non-empty payload example and field schema.
- `GET /v1/webhooks/event-catalog` returns the full catalog plus a summary header to a viewer key holding only `webhooks:read`.
- Subscribing to an unknown event type returns 400 with `code=unknown_event_type` and the offending names echoed back.
- Subscribing to a mix of known event types succeeds and round-trips them sorted in the response.
- Cross-tenant: tenant A's subscriptions are invisible to tenant B's `list`, and tenant B cannot hijack tenant A's subscription name (the existing per-tenant guard returns `403 cross_tenant_subscription`).

### Try the event catalog

Local API: <http://127.0.0.1:8000>. Local dashboard: <http://127.0.0.1:3000/workspace/webhooks/catalog>.

```bash
# Read the full catalog with a viewer-scope API key.
curl -s http://127.0.0.1:8000/v1/webhooks/event-catalog \
  -H "x-api-key: $ADHERENCE_API_KEY" | jq '{version, count, stable, beta, stable_event_types}'

# Subscribe to two real events; the request succeeds and lists them in the response.
curl -s -X PUT http://127.0.0.1:8000/v1/webhooks/outbound/subscriptions \
  -H "x-api-key: $ADHERENCE_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"care-team","url":"https://example.com/hook","event_types":["intervention.recommended","drift.detected"],"active":true}'

# A typo is now caught at the API edge instead of failing silently at dispatch.
curl -s -X PUT http://127.0.0.1:8000/v1/webhooks/outbound/subscriptions \
  -H "x-api-key: $ADHERENCE_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"typo","url":"https://example.com/hook","event_types":["intervention.recomended"],"active":true}'
# 400 {"detail":{"code":"unknown_event_type","unknown":["intervention.recomended"],"known":[...]}}
```

## DNS TXT verification for SSO auto-join domains

Workspace owners can claim email domains for SSO auto-join (`acme.com` -> Acme workspace). Until this release a freshly claimed domain auto-joined inbound SSO sign-ins immediately, which meant any tenant could capture sign-ins for a domain they did not actually control. The API now refuses to honour a claim until the workspace owner publishes a TXT record at `_adherence-ml-verify.<domain>` carrying the per-claim secret `adherence-ml-verify=<token>`. `resolve_auto_join` only considers rows with `verified_at IS NOT NULL`, so the SSO exchange path (`POST /v1/admin/sso/exchange`) and every other caller honour the gate without per-route changes.

Proven by `tests/unit/test_verified_domain_dns.py` (5 tests):

- A claim with `auto_join_enabled=true` but no DNS proof never wins `resolve_auto_join`.
- Publishing the correct TXT value flips the row to verified and unlocks auto-join end-to-end.
- A missing TXT or mismatched token surfaces as `txt_not_found` / `token_mismatch_dns` and leaves the row pending.
- `rotate_verification_token` mints a new secret and forces re-verification; the old TXT no longer wins.
- Cross-tenant: workspace A's published TXT cannot verify workspace B's claim on the same domain; two verified claims on one domain refuse to pick a winner (no silent cross-tenant capture).

### Try DNS verification

Local API: <http://127.0.0.1:8000>.

```bash
# 1. Claim the domain. The response includes the TXT record to publish and status='pending'.
curl -s -X POST http://127.0.0.1:8000/v1/workspace/verified-domains \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d '{"domain":"acme.test","default_role":"viewer","auto_join_enabled":true}'
# { ..., "status": "pending",
#        "txt_record": { "type": "TXT",
#                        "name": "_adherence-ml-verify.acme.test",
#                        "value": "adherence-ml-verify=..." } }

# 2. Re-fetch the challenge anytime (viewer scope is enough).
curl -s http://127.0.0.1:8000/v1/workspace/verified-domains/acme.test/verification \
  -H "authorization: Bearer $WORKSPACE_VIEWER_JWT"

# 3. Publish the TXT record at your DNS provider, then trigger verification.
curl -s -X POST http://127.0.0.1:8000/v1/workspace/verified-domains/acme.test/verify \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT"
# 422 { "detail": "txt_not_found" }     # before you publish
# 200 { "ok": true, "domain": { "status": "verified", ... } }

# 4. If a token leaks, rotate it. Auto-join pauses until you re-verify the new value.
curl -s -X POST http://127.0.0.1:8000/v1/workspace/verified-domains/acme.test/rotate-token \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT"
```

Every transition (`add`, `verify`, `rotate_token`, `remove`) writes a row to the admin audit log so SOC2 reviewers can trace exactly which principal proved control of which domain and when.

## Authenticated webhook admin console with audit-logged mutations

Dashboard-side webhook management (`/api/webhooks/*`) previously accepted unauthenticated requests, which would have failed an enterprise SOC2 review on first sweep. Every endpoint that lists, creates, toggles, deletes, test-fires, replays, or exports webhook data now requires a signed dashboard session and lands a row in the tamper-evident dashboard audit log (`recordAudit`). The new `/workspace/webhooks` page is a single console where an owner can register HMAC-signed outbound endpoints, browse the full delivery log with per-attempt status codes and durations, replay any failed delivery, send a `test.ping`, and export the last 500 attempts as CSV for an external SIEM.

Proven by `apps/web/tests/webhook-routes-auth.test.ts` (10 tests):

- Every mutating route (create, patch, delete, test-fire, replay) returns 401 without a session.
- The denied create attempt writes a `webhook.endpoint.create` audit row with `outcome=denied` and `reason=no_session`, the exact signal a security review will grep for.
- Read endpoints (list endpoints, list deliveries, get delivery, export) all gate on session so webhook URLs and secret prefixes cannot be enumerated unauthenticated.
- The documented `ADHERENCE_DASHBOARD_OPEN=1` dev bypass still lets local development through, with the bypass flag flowing into audit metadata.

### Try it

Dashboard: <http://127.0.0.1:3000/workspace/webhooks>. Sign in at `/dashboard`, click **new endpoint**, copy the one-time signing secret, then click **test** to fire a `test.ping` and watch the delivery land in the table below.

```bash
# Unauthenticated POST is now rejected with 401.
curl -sS -i -X POST http://127.0.0.1:3000/api/webhooks \
  -H 'content-type: application/json' \
  -d '{"name":"prod","url":"https://example.com/hook"}'
# HTTP/1.1 401 Unauthorized
# { "error": "unauthenticated", "detail": "...sign in..." }
```

## Webhook signing-secret rotation with grace window

Enterprise security teams require zero-downtime rotation of outbound HMAC signing secrets so a leaked or aging key can be replaced without dropping deliveries. The dashboard now lets a workspace owner rotate an outbound webhook secret with a configurable grace window (5 minutes to 7 days, default 24 hours). During the window we co-sign every delivery with the new secret as `X-Adherence-Signature` and the prior secret as `X-Adherence-Signature-Secondary`, letting receivers verify against either. The prior secret auto-expires (and is purged from disk on next read) and can also be killed immediately from the dashboard. Rotation honours `?dry_run=true` and the new plaintext is returned exactly once, mirroring the create-endpoint contract.

### Anti-replay outbound webhook signatures (v2)

Every outbound delivery now ships with an `X-Adherence-Timestamp` (unix seconds) and an `X-Adherence-Signature-V2: sha256=<hex(hmac(secret, "<timestamp>.<body>"))>` header alongside the legacy `X-Adherence-Signature`. Receivers should consume v2 only and reject any request whose timestamp skew vs wall clock exceeds 300 seconds (configurable), which makes a captured webhook delivery unreplayable once the window elapses even if the secret has not rotated. Helpers `adherence_common.outbound.sign_v2` and `verify_v2(secret, ts, body, sig, max_skew_seconds=300)` are exported so receivers (and tests) get a constant-time, fail-closed verifier with explicit reason codes. The legacy v1 header continues to ship during the deprecation window so existing receivers keep working unchanged. Secret rotation co-signs both v1 and v2 with the previous secret via `X-Adherence-Signature-Previous` and `X-Adherence-Signature-V2-Previous`.

Proven by `apps/web/lib/__tests__/webhooks-rotate.test.ts` (`pnpm tsx lib/__tests__/webhooks-rotate.test.ts`):

- A new plaintext is generated, the old secret hash lands in the secondary slot with an expiry, and primary and secondary HMACs over the same body differ.
- Lazy GC purges expired secondary material from disk on the next read so a stale secret cannot be revived by clock skew or process restart.
- `revokeEndpointSecondary` ends the grace window immediately and is idempotent.

### Try it

Dashboard: <http://127.0.0.1:3000/webhooks>. Click **rotate** on any endpoint, pick a grace window, and copy the new secret from the banner. The prior secret continues to co-sign deliveries until the countdown expires or you click **revoke now**.

```bash
# Rotate the signing secret for an endpoint with a 1-hour grace window.
curl -sS -X POST http://127.0.0.1:3000/api/webhooks/ep_abc123/rotate \
  -H 'content-type: application/json' \
  -d '{"grace_ms": 3600000}'
# { "secret": "whsec_...", "secondary_expires_at": 1717182000000, ... }

# Preview without changing anything.
curl -sS -X POST 'http://127.0.0.1:3000/api/webhooks/ep_abc123/rotate?dry_run=true' \
  -H 'content-type: application/json' -d '{}'

# End the grace window immediately.
curl -sS -X DELETE http://127.0.0.1:3000/api/webhooks/ep_abc123/rotate
```

## Per-workspace people seat enforcement

Enterprise pricing is per-seat, so the API now enforces a **member seat cap on every workspace**. A seat is consumed by every row in `workspace_members` and by every *pending* invitation in `workspace_invitations`, so an admin cannot quietly oversubscribe by sitting on a stack of open invites. Caps live on the plan catalog (`free=3`, `pro=25`, `enterprise=500`) with a per-workspace `member_seats_override` for custom contracts. Adding a member or sending another invite past the cap returns HTTP 409 with a structured `member_seat_limit` error carrying `plan`, `used`, `limit`, `members`, `pending_invitations`, so the dashboard and partner CLIs can show a precise upgrade prompt.

Enforcement is wired at the data layer (`adherence_common.memberships.upsert_member`, `create_invitation`) so every code path that adds a member is gated, not just the new ones. Acceptance is seat-neutral by design: a pending invite ticks down by one while the new member row ticks up by one. `GET /v1/quota/me` and `/v1/admin/quota/{tid}` now expose `member_seats_limit / used / remaining`, `members`, `pending_invitations` alongside the existing prediction and API-key seat counters, and the `/workspace/quota` dashboard page renders a second progress bar with a warning when the cap is reached. Validated by `tests/unit/test_workspace_member_seats.py`: tenant isolation (one workspace's usage does not block another), the third invite trips the gate on free, accept is seat-neutral, revoking a pending invite frees a seat, and `member_seats_override` raises the effective cap.

### Try people seats

Local API: <http://127.0.0.1:8000>. Dashboard: <http://127.0.0.1:3000/workspace/quota>.

```bash
# 1. As a workspace admin, see how many people seats you have.
curl -s http://127.0.0.1:8000/v1/quota/me \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT"
# { ..., "member_seats_limit": 3, "member_seats_used": 2,
#        "members": 1, "pending_invitations": 1, ... }

# 2. Invite the third teammate. Free plan cap = 3.
curl -s -X POST http://127.0.0.1:8000/v1/workspace/invitations \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d '{"email":"c@acme.test","role":"viewer"}'

# 3. The fourth invite is rejected with a structured 409 the UI can surface.
curl -s -X POST http://127.0.0.1:8000/v1/workspace/invitations \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d '{"email":"d@acme.test","role":"viewer"}'
# 409  {"detail":{"code":"member_seat_limit","plan":"free","used":3,"limit":3,...}}

# 4. Operator lifts the cap for an enterprise contract without changing tier.
curl -s -X PUT http://127.0.0.1:8000/v1/admin/quota/acme \
  -H "x-api-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"member_seats_override": 75}'
```

## Per-API-key daily usage counters

Enterprise customers need per-key call attribution for chargeback, capacity planning, and abuse review. Every successful API key resolution now increments a `(name, UTC day)` counter on `api_key_usage_daily`, written best-effort from the auth dependency so a misbehaving telemetry path can never break an authenticated request. Two new owner-only endpoints expose the history:

- `GET /v1/admin/api-keys/{name}/usage?days=30` returns a zero-filled window so a chart renders without client-side gap math, plus the peak day and peak count.
- `GET /v1/admin/api-keys/usage?days=14` returns a roll-up across all keys sorted by total desc, so an operator can spot the noisy keys without paging through history.
- `POST /v1/admin/api-keys/usage/purge` enforces retention policy by dropping rows strictly older than a cutoff date. Supports `?dry_run=true`.
- Every successful key resolve also writes the most recent source IP and User-Agent back to `api_key_records` (best-effort, display only). The `last_used_ip` and `last_used_user_agent` fields surface in `GET /v1/admin/api-keys` and on the dashboard, so a workspace admin can answer 'where was this key just used from?' without spelunking the request log. Both values are length-capped, never used to make security decisions (per-key IP allowlists still come from `ip_allowlist_csv`), and never overwritten with blanks.

Reads are themselves recorded in `admin_audit_log` so a compliance reviewer can later prove who looked at whose traffic. The counter is keyed by the durable key `name` so revoking and re-issuing a key does not erase its history. Counters and credentials live in separate tables so dropping history (retention) never touches the credential row, and write contention on a hot key cannot stall the auth path. Validated by `tests/integration/test_api_key_usage.py`, which asserts cross-key isolation, zero-fill, sort order, 404 on unknown keys, viewer denial, and audit-log capture.

### Try per-key usage

Local API: <http://127.0.0.1:8000>.

```bash
# 1. As an operator, create a key for the CI pipeline.
curl -s -X POST http://127.0.0.1:8000/v1/admin/api-keys \
  -H "x-api-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"ci-pipeline","role":"service"}'

# 2. Drive some traffic with the new key (any authenticated route counts).
curl -s http://127.0.0.1:8000/v1/health -H "x-api-key: $CI_KEY"

# 3. Inspect the last 30 days for that key.
curl -s 'http://127.0.0.1:8000/v1/admin/api-keys/ci-pipeline/usage?days=30' \
  -H "x-api-key: $ADMIN_KEY"

# 4. Workspace rollup, highest-traffic keys first.
curl -s 'http://127.0.0.1:8000/v1/admin/api-keys/usage?days=14' \
  -H "x-api-key: $ADMIN_KEY"
```

## Workspace legal acceptance (TOS / DPA gate)

Enterprise procurement asks: "Prove which version of your Terms of Service and Data Processing Agreement each of our workspaces accepted, by whom, when, from which IP." The API now publishes immutable legal document versions (`tos`, `dpa`, `privacy`), records per-workspace acceptance events with actor, IP, and user agent, and gates every mutating request behind acceptance via `LegalAcceptanceMiddleware`. A workspace that owes acceptance gets a 451 with a structured remediation payload (kind, version, sha256) instead of a generic 403. Read paths, `/v1/legal`, `/v1/gdpr`, health, metrics, and admin token mint stay open so a blocked tenant can self-serve or walk away with its data.

Key invariants enforced in tests (`tests/integration/test_legal_acceptance.py`):

- Per-tenant isolation: one workspace accepting does not unblock another.
- Idempotency: re-accepting the same `(kind, version)` by the same subject does not duplicate rows.
- sha256 mismatch rejects acceptance, proving the document body did not silently change under a previously-accepted version label.
- Green-field default (no published documents) does not gate any tenant.
- Every publish and accept event is written to `admin_audit_log`.

Scoped API keys can call the legal surface via the canonical scopes `legal:read`, `legal:accept`, `legal:publish` exposed in `/v1/auth/scopes`.

### Try it

Local API: <http://127.0.0.1:8000>.

```bash
# 1. As an operator (admin in the default tenant), publish the current TOS and DPA.
curl -s -X POST http://127.0.0.1:8000/v1/legal/documents \
  -H "authorization: Bearer $OPERATOR_JWT" \
  -H 'content-type: application/json' \
  -d '{"kind":"tos","version":"2026-01-01","title":"Terms of Service","body":"..."}'

curl -s -X POST http://127.0.0.1:8000/v1/legal/documents \
  -H "authorization: Bearer $OPERATOR_JWT" \
  -H 'content-type: application/json' \
  -d '{"kind":"dpa","version":"2026-01-01","title":"Data Processing Agreement","body":"..."}'

# 2. A workspace admin sees what they owe.
curl -s http://127.0.0.1:8000/v1/legal/outstanding \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT"
# { "tenant_id": "acme", "blocked": true, "outstanding": [ ... ] }

# 3. Acceptance unblocks the workspace. The optional sha256 pins the body.
curl -s -X POST http://127.0.0.1:8000/v1/legal/accept \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d '{"kind":"tos","version":"2026-01-01"}'

# 4. Audit trail for procurement: who accepted, when, from where.
curl -s http://127.0.0.1:8000/v1/legal/acceptances \
  -H "authorization: Bearer $WORKSPACE_ADMIN_JWT"
```

## Periodic access reviews (SOC2 CC6.3 / ISO 27001 A.9.2.5)

Workspace owners can run periodic access reviews to re-certify which members still need access. Opening a review snapshots every current member as a pending item; for each item an admin records keep, change (with a new role), or revoke. Closing the review applies every change and revoke to the live membership table in a single transaction and writes one admin audit row per applied decision. Reviews are strictly tenant-scoped: a review opened in workspace A is invisible (404) from workspace B, and decisions cannot cross tenants. Every mutation requires an active admin MFA challenge.

### Try access reviews

Local API: <http://127.0.0.1:8000>.

```bash
# Open a review. Snapshots current workspace members as pending items.
curl -s -X POST http://127.0.0.1:8000/v1/admin/access-reviews \
  -H "authorization: Bearer $ADMIN_JWT" \
  -H "x-admin-mfa: $MFA_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"label":"2026-Q2","reason":"quarterly recertification"}'

# Record a decision per member (keep | change | revoke).
curl -s -X POST http://127.0.0.1:8000/v1/admin/access-reviews/1/items/2/decide \
  -H "authorization: Bearer $ADMIN_JWT" -H "x-admin-mfa: $MFA_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"decision":"change","new_role":"viewer","note":"role drift"}'

# Dry-run the close to see what would be applied.
curl -s -X POST 'http://127.0.0.1:8000/v1/admin/access-reviews/1/close?dry_run=true' \
  -H "authorization: Bearer $ADMIN_JWT" -H "x-admin-mfa: $MFA_TOKEN" \
  -H 'content-type: application/json' -d '{}'

# Close for real. Applies change/revoke decisions and freezes the review.
curl -s -X POST http://127.0.0.1:8000/v1/admin/access-reviews/1/close \
  -H "authorization: Bearer $ADMIN_JWT" -H "x-admin-mfa: $MFA_TOKEN" \
  -H 'content-type: application/json' -d '{"summary":"all decisions applied"}'
```

## SCIM 2.0 user provisioning

Enterprise IdPs (Okta, Azure AD / Entra ID, OneLogin, JumpCloud) can
automatically provision and de-provision users into a workspace via
SCIM 2.0 (RFC 7644). A workspace admin mints a per-tenant bearer token,
pastes it into their IdP, and onboarding/offboarding tickets become
group membership changes upstream.

The SCIM bearer token is tenant-bound at issuance: the SCIM endpoints
only ever read and write members of the workspace the token belongs to,
regardless of what the IdP payload claims. Every provisioning mutation
is recorded in `admin_audit_log` and flows through the existing SIEM
drain.

### Try it

Local API: <http://127.0.0.1:8000>. SCIM discovery: <http://127.0.0.1:8000/scim/v2/ServiceProviderConfig>.

```bash
# 1. As a workspace admin, mint a SCIM token for your IdP.
curl -s -X POST http://127.0.0.1:8000/v1/admin/scim/tokens \
  -H "authorization: Bearer $ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d '{"name":"okta-prod"}'
# The `token` field is returned exactly once. Hand it to the IdP.

# 2. From the IdP's egress (simulated here), provision a user.
curl -s -X POST http://127.0.0.1:8000/scim/v2/Users \
  -H "authorization: Bearer $SCIM_TOKEN" \
  -H 'content-type: application/scim+json' \
  -d '{"userName":"alice@acme.com","active":true,"roles":[{"value":"viewer","primary":true}]}'

# 3. De-provision the user (PATCH active=false or DELETE).
curl -s -X DELETE http://127.0.0.1:8000/scim/v2/Users/$USER_ID \
  -H "authorization: Bearer $SCIM_TOKEN"

# 4a. Zero-downtime rotation: mint a successor while the old token keeps
#     working for a grace window so the IdP can swap credentials without
#     a single failed provisioning call. Default grace is 24h (60s..7d).
curl -s -X POST http://127.0.0.1:8000/v1/admin/scim/tokens/$TOKEN_ID/rotate \
  -H "authorization: Bearer $ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d '{"grace_seconds": 86400}'
# Response: { "token": "scim_...", "old": {...}, "new": {...}, "grace_seconds": 86400 }
# After the IdP is cut over (or the grace window elapses) the old token
# is auto-tombstoned on the next presentation. To revoke immediately:
curl -s -X DELETE http://127.0.0.1:8000/v1/admin/scim/tokens/$TOKEN_ID \
  -H "authorization: Bearer $ADMIN_JWT"
## CSP violation reporting (XSS canary)

The dashboard now wires browser CSP violation reports back into a tamper-resistant in-process ring buffer and a live admin panel, so operators can see exactly when a script-src or connect-src directive blocks something in the wild. Both envelopes are supported: the legacy `Content-Security-Policy: report-uri` (CSP Level 2) and the modern Reporting API (`Report-To`, `Reporting-Endpoints`, `report-to` directive). Every accepted report is also emitted as a structured `csp.violation` log line for SIEM ingest.

Ingest is bounded (8 KiB body cap, 512-entry ring, every string clipped) so untrusted POSTs cannot OOM the process. The admin view lives on the existing security headers page and auto-refreshes every 15 seconds.

Configure with:

- `ADHERENCE_CSP_REPORT_URI` override the ingest URL (defaults to the in-app endpoint)
- `ADHERENCE_DISABLE_CSP_REPORTS=1` opt out entirely

### Try it

```bash
cd apps/web && pnpm dev
# open http://localhost:3000/settings/security-headers and scroll to the
# "recent CSP violations" panel

# simulate a browser violation report
curl -s -X POST http://localhost:3000/api/security/csp-report \
  -H 'content-type: application/csp-report' \
  -d '{"csp-report":{"document-uri":"http://localhost:3000/dashboard","violated-directive":"script-src","blocked-uri":"https://evil.example.com/x.js","disposition":"enforce"}}' \
  -o /dev/null -w '%{http_code}\n'
# -> 204
```

## Workspace verified domains and SSO auto-join

Workspace owners self-serve add email domains they own (for example
`acme.com`). When an SSO sign-in arrives whose email matches an enabled
verified-domain claim, the user is auto-added to the claiming workspace
with the configured default role. No per-user invite, no ticket to the
operator. Each claim is tenant scoped (admins of one workspace cannot
see or mutate another's), and ambiguous claims (two workspaces with the
same enabled domain) refuse to resolve so cross-tenant capture is
impossible.

### Try it

Local API on `http://127.0.0.1:8000`:

```bash
# 1. List your workspace's verified domains (viewer scope).
curl -sS -H "Authorization: Bearer $JWT" \
  http://127.0.0.1:8000/v1/workspace/verified-domains

# 2. Claim a domain (admin scope). Server normalises and validates it.
curl -sS -XPOST -H "Authorization: Bearer $JWT_ADMIN" \
  -H "content-type: application/json" \
  -d '{"domain":"acme.test","default_role":"viewer","auto_join_enabled":true}' \
  http://127.0.0.1:8000/v1/workspace/verified-domains

# 3. Pause auto-join during a security audit without dropping the claim.
curl -sS -XPATCH -H "Authorization: Bearer $JWT_ADMIN" \
  -H "content-type: application/json" \
  -d '{"auto_join_enabled":false}' \
  http://127.0.0.1:8000/v1/workspace/verified-domains/acme.test

# 4. Remove the claim entirely.
curl -sS -XDELETE -H "Authorization: Bearer $JWT_ADMIN" \
  http://127.0.0.1:8000/v1/workspace/verified-domains/acme.test
```

Next SSO exchange for `*@acme.test` against `/v1/admin/sso/oidc/exchange`
will mint a JWT bound to the claiming tenant, create a `workspace_members`
row on first sign-in, and append a `sso.oidc.exchange` audit row that
carries the `auto_joined` detail block.

## Brute-force protection on sign-in

Magic-link issuance and TOTP verification are both throttled per-email
and per-IP. Five failed attempts inside a rolling window lock the
offending bucket for 15 minutes; the response is HTTP 429 with
`Retry-After` and `{ "error": { "code": "locked_out" } }`. Successful
2FA clears the email bucket so a real user is not stranded by earlier
typos. The protection covers credential stuffing on the second factor
and mailbox-pump attacks against the magic-link endpoint without
touching SSO sign-in.

Workspace admins can see active lockouts at
`/settings/login-throttle` and clear individual buckets; every clear is
recorded in the dashboard audit log. The same page exposes a per-scope
throttle policy editor backed by `GET/PUT /api/auth/lockouts/policy`,
so the failure window, attempt threshold, and lockout duration are
tunable per deployment (clamped to safe bounds, audit-logged on every
change, revertable to the built-in default).

### Try it

```bash
# Locked-out response after the threshold is crossed:
curl -i -X POST http://localhost:3000/api/auth/request \
  -H "content-type: application/json" \
  -d '{"email":"abuser@example.com"}'
# HTTP/1.1 429 Too Many Requests
# Retry-After: 900
# X-RateLimit-Scope: magic_request

# Admin view of currently locked buckets (requires a dashboard session):
curl -sS http://localhost:3000/api/auth/lockouts?only_locked=1 \
  -b cookies.txt

# Forgive one bucket:
curl -sS -X POST http://localhost:3000/api/auth/lockouts \
  -H "content-type: application/json" -b cookies.txt \
  -d '{"scope":"magic_request","key":"abuser@example.com"}'

# View and edit the throttle policy (per-deployment override):
curl -sS http://localhost:3000/api/auth/lockouts/policy -b cookies.txt
curl -sS -X PUT http://localhost:3000/api/auth/lockouts/policy \
  -H "content-type: application/json" -b cookies.txt \
  -d '{"policies":{"totp_verify":{"windowMs":300000,"maxAttempts":3,"lockoutMs":1800000}}}'
```

will mint a JWT bound to the claiming tenant, create a `workspace_members`
row on first sign-in, and append a `sso.oidc.exchange` audit row that
carries the `auto_joined` detail block.

## Per-tenant SIEM audit drain

Enterprise security teams require that audit events flow to their own
SIEM (Splunk HEC, Datadog Logs intake, in-house syslog forwarder) so
they can correlate vendor activity with the rest of their detection
stack. Each tenant configures one drain (`url` + HMAC `secret`); every
audit row written by `adherence_common.audit.record` is shipped in a
best-effort background thread with an `X-Adherence-Signature: sha256=<hex>`
header computed over the raw JSON body. Failures are retried with
exponential backoff and recorded to `tenant_siem_delivery`, queryable
and replayable from the admin console. Every read and mutation is
bound to the caller's own tenant id, so admins from one tenant cannot
see, replay, or delete another tenant's drain or delivery rows.

### Try it

```bash
# Configure the drain (admin role, scope admin:network)
curl -s -X PUT http://localhost:8000/v1/admin/siem \
  -H "x-api-key: $ADHERENCE_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://siem.example.com/hec","secret":"a-long-shared-secret","enabled":true}' | jq

# Fire a signed test event (verifies receiver + secret)
curl -s -X POST http://localhost:8000/v1/admin/siem/test \
  -H "x-api-key: $ADHERENCE_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"message":"hello from adherence-ml"}' | jq

# Inspect delivery log
curl -s http://localhost:8000/v1/admin/siem/deliveries \
  -H "x-api-key: $ADHERENCE_ADMIN_KEY" | jq

# Replay a failed delivery
curl -s -X POST http://localhost:8000/v1/admin/siem/deliveries/42/replay \
  -H "x-api-key: $ADHERENCE_ADMIN_KEY" | jq
```

Receivers should verify the signature before accepting:
`hmac.new(secret, body, sha256).hexdigest()` must equal the hex after
`sha256=` in `X-Adherence-Signature`.

## Fine-grained API key scope enforcement

API keys carry a comma-separated scope allowlist (e.g.
`predict:write,interventions:read`). Until now only `/v1/gdpr/*`
consulted that list; every other mutating route fell back to coarse
role checks, meaning a key marked `predict:read` could still mint
tokens, manage members, or change retention policy. A new
`ScopeEnforceMiddleware` now maps every catalogued route to a canonical
scope (see `services/api/adherence_api/scope_catalog.py`) and returns
`403 insufficient_scope` with an `X-Required-Scope` header when a
scoped key reaches a route outside its allowlist. Keys with an empty
scope set keep the legacy "role-only" behaviour so existing deployments
upgrade cleanly.

### Try it

```bash
# 1. List the canonical scope catalog and the scopes your credential holds.
curl -s http://localhost:8000/v1/auth/scopes \
  -H "x-api-key: $ADHERENCE_API_KEY" | jq

# 2. Dry-run a permission decision without invoking the route.
curl -s "http://localhost:8000/v1/auth/scopes/check?method=POST&path=/v1/admin/memberships" \
  -H "x-api-key: $ADHERENCE_API_KEY" | jq

# 3. A scoped key hitting an out-of-scope route returns 403.
curl -i http://localhost:8000/v1/admin/token \
  -H "x-api-key: $SCOPED_KEY" \
  -H "content-type: application/json" \
  -d '{"subject":"u1","role":"viewer"}'
# HTTP/1.1 403 Forbidden
# X-Required-Scope: admin:keys
```

## Per-workspace data residency

Enterprise buyers (especially EU healthcare and US public sector)
require a contractually enforceable region pin. A workspace admin can
now pin their tenant to one of the supported regions via
`/v1/workspace/residency`. The choice is the single source of truth
that the runtime consults: every tenant-bound response carries an
`X-Data-Residency` header echoing the active region, every mutation is
admin-MFA gated and lands in the admin audit chain, and the pin is
strictly tenant-scoped so changing `acme` cannot affect `globex`.
Unknown region codes are rejected before they touch the audit chain.
When no pin is set, the deployment default (`us`) is used. Behavior is
verified end-to-end in `tests/integration/test_residency.py`.

### Try it

```bash
# View the active region for your workspace (default until pinned).
curl -sS http://localhost:8000/v1/workspace/residency \
  -H "Authorization: Bearer $WORKSPACE_JWT" -i | head -20

# Preview a pin to eu without mutating anything.
curl -sS -X PUT "http://localhost:8000/v1/workspace/residency?dry_run=true" \
  -H "Authorization: Bearer $WORKSPACE_JWT" \
  -H "Content-Type: application/json" \
  -d '{"region":"eu"}'

# Pin the workspace to eu. The response (and every later tenant-bound
# response) carries `X-Data-Residency: eu`.
curl -sS -X PUT http://localhost:8000/v1/workspace/residency \
  -H "Authorization: Bearer $WORKSPACE_JWT" \
  -H "Content-Type: application/json" \
  -d '{"region":"eu"}'
```

Local API: <http://localhost:8000>. Dashboard: <http://localhost:3000>.

## Per-workspace PII redaction policy

Enterprise verticals (HIPAA, GDPR, PCI) require that free-text fields
the platform persists have personal identifiers stripped before they
hit durable storage. A workspace admin can now configure which
built-in patterns (email, phone, ssn, mrn, credit_card, ipv4) and
optional custom regexes are scrubbed for their tenant via
`/v1/workspace/pii-policy`. The policy is enforced at two wiring
sites: `record_admin_action` scrubs the `details` blob of every admin
mutation, and the medtracker inbound webhook scrubs `DoseOutcome.notes`
when the operator has mapped its source to the receiving tenant via
the `ADHERENCE_INBOUND_SOURCE_TENANTS` setting. The policy is strictly
tenant-scoped: enabling email scrubbing for `acme` does not affect
`globex`. Invalid regex is rejected with HTTP 422 before any audit row
is written. Behavior is verified end-to-end in
`tests/integration/test_pii_policy.py`.

### Try it

```bash
# View the active policy (empty until set).
curl -sS http://localhost:8000/v1/workspace/pii-policy \
  -H "Authorization: Bearer $WORKSPACE_JWT"

# Enable email + ssn scrubbing with a custom MRN-like pattern.
curl -sS -X PUT http://localhost:8000/v1/workspace/pii-policy \
  -H "Authorization: Bearer $WORKSPACE_JWT" \
  -H "Content-Type: application/json" \
  -d '{"enabled_builtins":["email","ssn"],"custom_patterns":["PT\\d{6}"],"mask":"[REDACTED]"}'

# Preview clearing the policy without mutating anything.
curl -sS -X DELETE "http://localhost:8000/v1/workspace/pii-policy?dry_run=true" \
  -H "Authorization: Bearer $WORKSPACE_JWT"
```

## Outbound webhook circuit breaker

A dead receiver should not burn retries forever. Every outbound
`WebhookSubscription` now tracks `consecutive_failures`; a successful
2xx delivery resets it to zero, and once it crosses
`ADHERENCE_OUTBOUND_CIRCUIT_BREAKER_THRESHOLD` (default 10) the
subscription is auto-disabled: `disabled_at` is stamped,
`disabled_reason` records the trip, dispatch skips it on every
subsequent event, and `POST /v1/webhooks/outbound/deliveries/{id}/replay`
refuses with 404 until an admin clears the breaker. Re-enable with
`POST /v1/webhooks/outbound/subscriptions/{name}/reset-breaker`
(supports `?dry_run=true` to preview). Tenant scoping is preserved on
every path: an admin can only reset a subscription owned by their own
workspace. Behavior is verified in
`tests/integration/test_webhook_circuit_breaker.py`.

### Try it

```bash
# Inspect breaker state on your subscriptions.
curl -sS http://localhost:8000/v1/webhooks/outbound/subscriptions \
  -H "x-api-key: $ADMIN_KEY" | jq '.[] | {name, consecutive_failures, disabled_at, disabled_reason}'

# Preview the reset without mutating anything.
curl -sS -X POST "http://localhost:8000/v1/webhooks/outbound/subscriptions/clinic-prod/reset-breaker?dry_run=true" \
  -H "x-api-key: $ADMIN_KEY"

# Clear the breaker so dispatch resumes.
curl -sS -X POST http://localhost:8000/v1/webhooks/outbound/subscriptions/clinic-prod/reset-breaker \
  -H "x-api-key: $ADMIN_KEY"
```

Local API: <http://localhost:8000>. Dashboard: <http://localhost:3000>.

## Tenant-scoped webhook dead-letter queue

A delivery that fails every retry attempt is now marked `dead_letter`
instead of the generic `failed`, so operators can tell a transient
blip apart from a giving-up event that needs human attention. Each
`WebhookDelivery` row carries a denormalised `tenant_id` populated at
dispatch time and backfilled from the owning subscription on first
startup, which means cross-tenant isolation is enforced with a single
`WHERE tenant_id = ?` clause on every listing, retention sweep, and
DLQ count, not via an implicit join an unrelated route might forget.
The scenario is locked down in
`tests/integration/test_outbound_delivery_tenant_isolation.py`: two
tenants register their own subscriptions, both deliveries exhaust
retries, and each tenant sees exactly its own DLQ entry while the
other tenant's id 404s on replay.

### Try it

```bash
# How many deliveries gave up on this workspace?
curl -sS http://localhost:8000/v1/webhooks/outbound/deliveries/dead-letter \
  -H "x-api-key: $ADMIN_KEY" | jq '{count, items: [.items[] | {id, event_type, status_code, error}]}'

# Replay one of them after fixing the receiver.
curl -sS -X POST http://localhost:8000/v1/webhooks/outbound/deliveries/123/replay \
  -H "x-api-key: $ADMIN_KEY"
```

## Per-workspace legal hold (litigation / preservation order)

Enterprise legal teams need a way to freeze deletions when a matter,
audit, or regulator request lands. While at least one legal hold is
active on a workspace, every delete path in the API refuses to run
and returns `423 Locked` with `code: legal_hold_active`:

* `DELETE /v1/users/{user_id}/data` (GDPR right to erasure)
* `POST   /v1/admin/retention-policy/sweep` (scheduled retention sweep,
  except dry-runs which remain available for previewing scope)

Reads, exports, predictions, audit, and webhooks are untouched. Only
hard-deletes are blocked, which is the entire legal point of a
preservation order. Holds are placed and released by workspace admins
with a verified MFA challenge, recorded immutably in `legal_holds`,
and surfaced in the admin audit log. Cross-tenant isolation is
verified in `tests/unit/test_legal_hold.py` so a hold on tenant A
cannot be released from tenant B's scope and never affects tenant B's
deletes.

### Try it

Local API runs on `http://localhost:8000`. The dashboard at
`http://localhost:3000/settings/legal-hold` is the same surface.

```bash
# Place a hold (admin + MFA required).
curl -sS -X POST http://localhost:8000/v1/admin/legal-holds \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "x-mfa-code: $TOTP" \
  -H "content-type: application/json" \
  -d '{
    "label": "SUP-4218",
    "ticket_ref": "JIRA-LEGAL-77",
    "reason": "preservation order for matter SUP-4218 per signed counsel runbook"
  }'

# List active and historical holds for this workspace.
curl -sS http://localhost:8000/v1/admin/legal-holds \
  -H "authorization: Bearer $ADMIN_TOKEN"

# A GDPR erase attempt while a hold is active is refused.
curl -sS -i -X DELETE http://localhost:8000/v1/users/user-1/data \
  -H "authorization: Bearer $ADMIN_TOKEN"
# HTTP/1.1 423 Locked
# {"detail":{"code":"legal_hold_active", ...}}

# Release the hold (admin + MFA required).
curl -sS -X POST http://localhost:8000/v1/admin/legal-holds/1/release \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "x-mfa-code: $TOTP" \
  -H "content-type: application/json" \
  -d '{"release_reason": "matter SUP-4218 closed per counsel"}'
```

UI: <http://localhost:3000/settings/legal-hold>.

## Per-workspace outbound webhook host allowlist

Workspace owners can now restrict outbound webhook destinations to a
list of approved hostnames. Empty list keeps the deployment-wide
policy in effect; one or more rows narrow the gate for that workspace
only. Hostnames support exact match (`api.partner.com`) and a leading
dot subdomain wildcard (`.partner.com`). Each rule is checked at both
subscription create time and on every dispatch, so a tenant tightening
its egress policy retroactively blocks its own existing subscriptions
and the refusal lands in the webhook delivery log with `state=blocked`.
Add, remove, and audit-log entries through `/v1/admin/outbound-host-allowlist`
or the settings UI at `/settings/outbound-host-allowlist`. Cross-tenant
isolation is verified in `tests/unit/test_outbound_host_allowlist.py`.

### Try it

```bash
# List the current workspace allowlist (admin token required).
curl -sS http://localhost:8000/v1/admin/outbound-host-allowlist \
  -H "authorization: Bearer $ADMIN_TOKEN"

# Add an approved partner hostname.
curl -sS -X POST http://localhost:8000/v1/admin/outbound-host-allowlist \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"host": "api.partner.com", "label": "prod partner"}'

# Dry-run a destination URL against the active policy (global + tenant).
curl -sS -X POST http://localhost:8000/v1/webhooks/outbound/policy/check \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"url": "https://elsewhere.example/hook"}'
```

UI: <http://localhost:3000/settings/outbound-host-allowlist>.

## Break-glass logging for cross-tenant admin access

Enterprise procurement reviewers (HIPAA, SOC2, ISO 27001) reject any
SaaS that lets staff quietly read a customer's data. Admin roles in
this API can already operate across tenants (compliance audits,
support, fleet rollups). Until now, the only trail was a regular admin
audit row buried among thousands of same-tenant ops.

Every cross-tenant access now requires the
`X-Break-Glass-Justification` header (10 to 2048 chars after strip) and
is recorded in a dedicated, append-only `break_glass_events` table
scoped to the *target* tenant. Owners of the impacted workspace see
every time an outside operator (or another tenant's admin) reached
into their data, with who, when, source tenant, route, method, client
IP, request id, and the written justification.

Fleet-wide access (`tenant=*`) is itself a break-glass action and is
recorded against the `*` scope so the vendor's own SRE leadership can
review it.

### Try it

Local API runs on `http://localhost:8000`.

```
# 1. Same-tenant admin reads its own audit log; no header required.
curl -sS http://localhost:8000/v1/audit/list \
  -H 'Authorization: Bearer <acme-admin-jwt>'

# 2. Cross-tenant attempt without a justification is rejected 400.
curl -sS -i 'http://localhost:8000/v1/audit/list?tenant=globex' \
  -H 'Authorization: Bearer <acme-admin-jwt>'
# HTTP/1.1 400 Bad Request
# {"detail":{"code":"break_glass_required", ...}}

# 3. With a real justification, the access succeeds AND a row is
#    recorded against tenant=globex.
curl -sS 'http://localhost:8000/v1/audit/list?tenant=globex' \
  -H 'Authorization: Bearer <acme-admin-jwt>' \
  -H 'X-Break-Glass-Justification: Investigating ticket SUP-4218 per signed SRE runbook'

# 4. The impacted tenant's owner reviews break-glass activity.
curl -sS http://localhost:8000/v1/admin/break-glass \
  -H 'Authorization: Bearer <globex-admin-jwt>'

# 5. Export the full log as CSV for the customer's SIEM.
curl -sS http://localhost:8000/v1/admin/break-glass/export.csv \
  -H 'Authorization: Bearer <globex-admin-jwt>' \
  -o globex-break-glass.csv
```

See `packages/common/adherence_common/break_glass.py` and the
integration suite at `tests/integration/test_break_glass.py`.

## Per-source IP allowlist for inbound webhooks

Partner systems (Med-Tracker and friends) post ground-truth dose
outcomes to `/v1/webhooks/<source>/...`. HMAC alone is not enough for
enterprise security reviews: a leaked secret could be replayed from any
egress IP to forge outcome rows that flow into model promotion gates.

The inbound receiver now enforces a per-source IP / CIDR allowlist
*before* HMAC verification. Sources without a rule remain unrestricted
(back-compat); sources with at least one rule accept only matching
client IPs and return `403 Forbidden` for everything else, including
requests that carry an otherwise valid signature.

Configure with `ADHERENCE_INBOUND_WEBHOOK_IP_ALLOWLIST`:

```
ADHERENCE_INBOUND_WEBHOOK_IP_ALLOWLIST="medtracker:10.0.0.0/8,medtracker:54.230.0.0/16,rxops:198.51.100.7"
```

Client IP is taken from `X-Forwarded-For` (first hop), then
`X-Real-IP`, then the socket peer, matching the existing tenant
allowlist middleware.

### Try it

Local API runs on `http://localhost:8000`.

```
# 1. See the current inbound posture (signed + IP-restricted per source)
curl -sS http://localhost:8000/v1/webhooks/inbound/config \
  -H 'X-API-Key: <service-key>' | jq

# 2. Outside-the-allowlist call is rejected at the network layer,
#    even with a valid HMAC envelope.
curl -sS -i -X POST http://localhost:8000/v1/webhooks/medtracker/event \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <service-key>' \
  -H 'X-Forwarded-For: 203.0.113.9' \
  -d '{"source":"medtracker","events":[]}'
# HTTP/1.1 403 Forbidden
# {"detail":"inbound webhook ip: client ip 203.0.113.9 not in allowlist"}
```

See `packages/common/adherence_common/inbound_webhook_ip.py` and the
integration suite at
`tests/integration/test_webhook_inbound_ip_allowlist.py`.

## W3C Trace Context propagation (end-to-end correlation)

Every request to the FastAPI service honors the W3C `traceparent`
header. If the caller already opened a span in their APM (Datadog,
Honeycomb, Tempo, Jaeger), the same `trace_id` flows through this
service and shows up in:

- the access log line (`trace_id`, `span_id`, `trace_inbound`)
- the response headers (`traceparent`, `x-trace-id`, `x-request-id`)
- any OpenTelemetry spans the SDK emits when `OTEL_EXPORTER_OTLP_ENDPOINT` is set

When no upstream context is supplied, a spec-compliant `traceparent`
is minted so dashboards always have something to grep on.

### Try it

Local API runs on `http://localhost:8000`.

```
curl -sS -i http://localhost:8000/healthz \
  -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  | grep -iE 'traceparent|x-trace-id|x-request-id'
```

Expected: `x-trace-id: 4bf92f3577b34da6a3ce929d0e0e4736` echoed back,
matching `traceparent` on the response, plus a fresh `x-request-id`.
Drop the header and rerun; both headers are still present and the
`trace_id` is freshly minted.

See `packages/common/adherence_common/trace_context.py` and the
`RequestIdMiddleware` in `services/api/adherence_api/middleware.py`.

## Tamper-evident audit chain verification + signed evidence bundle

The dashboard audit log (`apps/web/lib/dashboard-audit.ts`) is an append-only
JSONL with a per-entry SHA-256 chain (each row embeds the hash of the previous
row). The new audit page surfaces this as auditor-grade evidence:

- `GET /api/audit/integrity` recomputes every hash, confirms every
  `prev_hash` linkage, and returns a structured report (entry count, head/tip
  timestamps, tip hash, genesis sentinel, first break index/id/reason,
  corrupt-line flag, verification timestamp). The verification is itself
  recorded as a `audit.integrity.verify` entry so the tip advances on each
  call.
- `GET /api/audit/bundle` returns a single JSON document
  (`adherence.audit.bundle.v1`) with the manifest, the integrity report, and
  every entry in chronological order. The manifest carries an `entries_root`
  = sha256 over the concatenation of every entry hash so a buyer's security
  team can recompute it from the entries alone and detect any post-export
  tampering. Workspace-scoped exports (`?workspace_id=...`) require the
  owner role; denials are audited.
- The `/audit` page renders an integrity card with status pill, head/tip
  timestamps, full tip + genesis hashes, a re-verify button, and a one-click
  signed bundle download. A broken chain shows the exact first break index,
  entry id, and reason.

Try it locally:

```bash
cd apps/web
pnpm install
ADHERENCE_DASHBOARD_OPEN=1 pnpm dev
# then in another shell:
curl -sS http://localhost:3000/api/audit/integrity | jq
curl -sS -OJ http://localhost:3000/api/audit/bundle
```

Visit http://localhost:3000/audit to see the integrity panel.

## Workspace data export (GDPR / CCPA)

Workspace owners can download every record their workspace owns as a single
bundle, with a dry-run preview that returns counts only.

* `GET /api/workspaces/{id}/export?dry_run=1` returns the manifest (counts
  of members, invites, verified domains, audit entries, runs, notes) without
  reading the heavy stores. Both preview and download are written to the
  dashboard audit log.
* `GET /api/workspaces/{id}/export` downloads the full JSON bundle:
  workspace record, members, invites, verified domains, public SSO config,
  security policy, audit entries scoped to the workspace, runs and notes
  authored by current members.
* `GET /api/workspaces/{id}/export?format=csv` returns the runs slice as
  RFC 4180 CSV for spreadsheet handoff.
* Owner-only. Non-owners get `403`. Non-members get `404`. Cross-tenant
  runs are filtered out at the query layer; see
  `apps/web/tests/workspace-export.test.ts`.

### Try it

Local dev runs on `http://localhost:3000`.

```bash
cd apps/web && pnpm dev
# UI: http://localhost:3000/workspace/export
# Manifest preview (owner cookie required):
curl -b cookies.txt 'http://localhost:3000/api/workspaces/<id>/export?dry_run=1'
# Full JSON bundle:
curl -b cookies.txt -OJ 'http://localhost:3000/api/workspaces/<id>/export'
# Runs CSV:
curl -b cookies.txt -OJ 'http://localhost:3000/api/workspaces/<id>/export?format=csv'
```

## Workspace invitations and member management

Enterprise buyers expect to invite teammates by email instead of minting
long-lived API keys for each person. The `/v1/workspace` API exposes the
full membership lifecycle, scoped strictly to the calling principal's
tenant, with every mutation written to `admin_audit_log`.

* `POST   /v1/workspace/invitations` issues a single-use accept token
  (admin only). The plaintext token is returned exactly once; only the
  sha256 hash is persisted. Supports `?dry_run=true` for change review.
* `GET    /v1/workspace/invitations` lists pending invites; pass
  `include_resolved=true` to see accepted, revoked, and expired rows.
* `DELETE /v1/workspace/invitations/{id}` revokes a pending invite.
* `GET    /v1/workspace/invitations/preview?token=...` is the one
  unauthenticated endpoint; the invitee uses it to see what workspace
  and role they were offered before signing up.
* `POST   /v1/workspace/invitations/accept` consumes the token,
  creates the membership row, and ties the caller's subject to the new
  workspace. Rejects expired (`410`), revoked (`410`),
  already-accepted (`409`), or email-mismatched (`403`) tokens with
  precise error codes.
* `GET    /v1/workspace/members` lists members in the caller's tenant.
* `PATCH  /v1/workspace/members/{subject}` changes a member's role.
* `DELETE /v1/workspace/members/{subject}` removes a member.
* The API refuses to demote or remove the last admin (`409`), so a
  workspace never ends up unmanageable.

Tenants are isolated at the query layer: `tests/integration/test_workspace_memberships.py`
proves that an admin in tenant `globex` cannot list, revoke, or accept
invitations issued by tenant `acme`, and that viewers cannot mutate
invites in their own tenant.

### Try it

```bash
# As an admin in workspace acme, invite engineer@acme.test as a viewer.
curl -sS -X POST http://localhost:8000/v1/workspace/invitations \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"email":"engineer@acme.test","role":"viewer"}' | tee /tmp/invite.json

TOKEN=$(jq -r .token /tmp/invite.json)

# Anonymous preview (safe to render before sign-up).
curl -sS "http://localhost:8000/v1/workspace/invitations/preview?token=$TOKEN"

# Mint a JWT for the invitee and accept.
INVITEE=$(curl -sS -X POST http://localhost:8000/v1/admin/token \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"subject":"engineer@acme.test","role":"viewer","tenant":"acme"}' \
  | jq -r .token)

curl -sS -X POST http://localhost:8000/v1/workspace/invitations/accept \
  -H "Authorization: Bearer $INVITEE" -H "content-type: application/json" \
  -d "{\"token\":\"$TOKEN\"}"

# Confirm the member is in.
curl -sS http://localhost:8000/v1/workspace/members \
  -H "x-api-key: $ADMIN_KEY" | jq '.members[] | {subject, role}'
```

## Verified email domains and auto-join (enterprise onboarding)

IT teams will not click "Invite user" 400 times. Workspace owners can
now claim an email domain (for example `acme.com`), prove ownership by
publishing a TXT record at `_adherence-ml-verify.<domain>`, and flip an
`auto_join` toggle. After that, any new sign-in whose email lives in
the verified domain is provisioned into the workspace at the role the
owner picked (`editor` or `viewer`). No invite emails, no shared
secrets, no second portal.

Verification is a real DNS lookup. The dashboard server resolves the
TXT records at `_adherence-ml-verify.<domain>` via Node's stub resolver
(`lib/dns-verify.ts`) and only flips the claim to `verified` when one
of those records matches the issued token. Failure modes surface as
specific HTTP 422 errors (`txt_not_found`, `token_mismatch_dns`,
`dns_lookup_failed`) so owners can see exactly what to fix at their DNS
provider. The legacy operator-trust path is still available for local
dev and tests when `ADHERENCE_DOMAIN_DNS_ALLOW_BYPASS=1` is set; in any
other environment, a real TXT record is required.

Guarantees enforced in `lib/workspaces-store.ts` and audited via
`recordAudit`:
- Public providers (`gmail.com`, `outlook.com`, etc.) cannot be claimed.
- A domain can only be `verified` in one workspace at a time, so a
  rival tenant cannot hijack onboarding for your company.
- `auto_join` is rejected while a claim is still `pending`.
- Only the workspace `owner` can claim, verify, toggle, or unclaim a
  domain; every mutation is logged with actor, IP, target, and outcome.
- `?dry_run=true` is honored on every claim/update/unclaim route.
- Cross-tenant isolation and the real-DNS verification path are covered
  by `apps/web/tests/workspace-domains.test.ts` and
  `apps/web/tests/workspace-domains-dns.test.ts` (10 vitest cases).

### Try it

```bash
cd apps/web && pnpm dev
# open http://localhost:3000/workspace/domains
# or via API (after signing in to get a session cookie):
curl -X POST http://localhost:3000/api/workspaces/<ws_id>/domains \
  -H 'content-type: application/json' \
  --cookie "session=$SESSION" \
  -d '{"domain":"acme.com","default_role":"editor"}'
```

## JWT session revocation (sign out everywhere)

Until now, a stolen JWT was good until its `exp`. Enterprise security
teams need a way to kill a session immediately when a laptop walks out
the door, or to invalidate every outstanding token for an employee
being offboarded. Every minted JWT now carries a `jti` claim, and two
admin endpoints invalidate tokens without waiting on `exp`.

* `POST /v1/admin/sessions/revoke` revokes one token by its `jti`.
* `POST /v1/admin/sessions/revoke-all` revokes every token issued for a
  `sub` (optionally scoped to a `tenant`) at or before `cutoff_iat`
  (default: now). New tokens minted afterwards keep working, so a user
  can be signed out of every device and then log back in cleanly.

Both endpoints are admin-only, MFA-gated, support `?dry_run=true`, and
write to `admin_audit_log` with the actor, target, request id, and
reason. The revocation check runs inside `verify_jwt`, so every route
that accepts a Bearer token enforces it; if the backing store is
unreachable the check fails open and degrades gracefully (matching how
the audit chain handles outages).

### Try it

```bash
# Mint a viewer token.
TOKEN=$(curl -sS -X POST http://localhost:8000/v1/admin/token \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"subject":"alice","role":"viewer","tenant":"acme"}' | jq -r .token)

# Read the jti claim (no signature check, just for the demo).
JTI=$(python3 -c "import jwt,sys;print(jwt.decode(sys.argv[1],options={'verify_signature':False})['jti'])" "$TOKEN")

# Token works.
curl -sS http://localhost:8000/v1/quota/me -H "Authorization: Bearer $TOKEN"

# Revoke just that one token.
curl -sS -X POST http://localhost:8000/v1/admin/sessions/revoke \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d "{\"jti\":\"$JTI\",\"sub\":\"alice\",\"tenant\":\"acme\",\"reason\":\"laptop lost\"}"

# Same token is now 401.
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:8000/v1/quota/me \
  -H "Authorization: Bearer $TOKEN"   # => 401

# Sign Bob out of every device.
curl -sS -X POST http://localhost:8000/v1/admin/sessions/revoke-all \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"sub":"bob","tenant":"acme","reason":"offboarding"}'
```

## Per-workspace session max-age policy

The global `jwt_ttl_seconds` applies uniformly across all tenants,
which does not fit regulated workspaces that need a tighter cap (a
healthcare tenant may want 30 minute sessions while a sandbox tenant
allows 24 hours). A workspace admin can now set a per-tenant cap that
short-circuits any JWT older than `max_age_seconds`, regardless of how
long the global TTL would have honoured it.

* `GET /v1/workspace/session-policy` returns the current cap (or `null`
  when the tenant uses the global TTL).
* `PUT /v1/workspace/session-policy` sets `max_age_seconds` in the
  range `[60, 2592000]` (1 minute to 30 days).
* `DELETE /v1/workspace/session-policy` lifts the cap.

The enforcement runs inside `verify_jwt` alongside the revocation check
and is tenant-scoped: capping tenant `acme` does not affect tokens
issued for tenant `globex`. The check fails open on backend errors so a
single DB hiccup never locks every client out. Every mutation is
admin-only, MFA-gated, supports `?dry_run=true`, and lands in
`admin_audit_log` with the actor, request id, and the new value.

### Try it

```bash
# Mint an admin token for the tenant whose cap you want to manage.
ADMIN_TOKEN=$(curl -sS -X POST http://localhost:8000/v1/admin/token \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"subject":"alice","role":"admin","tenant":"acme"}' | jq -r .token)

# Read current policy.
curl -sS http://localhost:8000/v1/workspace/session-policy \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Cap acme sessions to 15 minutes.
curl -sS -X PUT http://localhost:8000/v1/workspace/session-policy \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"max_age_seconds": 900}'

# Tokens minted before that change keep working until they hit the cap;
# anything older than 15 minutes is now rejected with HTTP 401.

# Lift the cap.
curl -sS -X DELETE http://localhost:8000/v1/workspace/session-policy \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Per-workspace API key lifetime policy (forced rotation)

Procurement teams in regulated verticals ask for a documented key
rotation cadence ("every API key in this workspace must expire within
90 days, no exceptions"). Until now the API would happily mint a
non-expiring key or a 5-year key in any tenant, so the only enforcement
was a wiki page.

A workspace admin can now declare a per-tenant policy that the backend
enforces on every `api_key.create` and `api_key.rotate` call. Requests
that would issue a key longer-lived than `max_ttl_seconds` (or, when
`require_expiry` is true, any key without an expiry) are rejected with
HTTP 400, a structured `api_key_policy_violation` error, and an admin
audit row showing the attempt.

The policy is tenant-scoped: capping `acme` does not affect a key
minted for tenant `globex` in the same deployment. There is a 1 day
floor (avoid an operator pinning herself out instantly) and a 5 year
ceiling, matching the existing global `ttl_seconds` bounds.

Endpoints under `/v1/workspace/api-key-policy`:

* `GET    /v1/workspace/api-key-policy` returns the current policy
  (`max_ttl_seconds: null` means no per-tenant cap).
* `PUT    /v1/workspace/api-key-policy` sets `max_ttl_seconds`,
  `require_expiry`, an optional `max_active_keys` cap, and an optional
  `max_dormant_days` inactivity window (admin only, MFA-gated, dry-run
  aware). The active-key cap rejects
  `api_key.create` with HTTP 400 `active_key_limit_exceeded` once the
  workspace already has that many non-revoked, non-expired keys, and
  sits *below* the plan seat ceiling so a 100-seat plan can be locked
  to (say) 5 active keys in a production tenant without changing
  billing. When `max_dormant_days` is set, any API key whose
  `last_used_at` (or `created_at` for never-used keys) is older than
  that window is auto-revoked the next time it is presented, and an
  admin-audit row `api_key.auto_disabled.dormant` is written; the
  caller receives `401 api key auto-disabled (dormant)` and no
  silent env-key fallback occurs.
* `DELETE /v1/workspace/api-key-policy` lifts the cap.

Try it locally:

```bash
# Inspect the current policy for your tenant.
curl -sS http://localhost:8000/v1/workspace/api-key-policy \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Force 7-day rotation, require every key to declare an expiry, cap
# the workspace to at most 5 simultaneously-active keys, and auto-revoke
# any key that goes 30 days without use.
curl -sS -X PUT http://localhost:8000/v1/workspace/api-key-policy \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"max_ttl_seconds": 604800, "require_expiry": true, "max_active_keys": 5, "max_dormant_days": 30}'

# A 90-day key request now fails with api_key_policy_violation.
curl -sS -X POST http://localhost:8000/v1/admin/api-keys \
  -H "x-api-key: $ADHERENCE_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"too-long","role":"viewer","ttl_seconds":7776000,"tenant_id":"acme"}'
```

## Per-workspace data retention policy

Procurement teams in regulated verticals routinely require that each
customer workspace can declare its own retention ceiling for audit and
prediction tables, independent of the deployment-wide default. A US
clinical trial workspace may need to keep `prediction_audit` rows for 7
years; a European demo workspace must purge them after 30 days. The
global `retention.sweep` defaults are a deployment-wide policy and
cannot express that.

Each workspace admin can now set per-table TTLs for the tenant-scoped
retention targets (`predictions`, `prediction_audit`, `admin_audit_log`)
and run a tenant-scoped sweep. Every SQL DELETE filters by
`tenant_id`, so one workspace cannot affect another's rows even if an
admin sends a hand-crafted payload.

Endpoints under `/v1/workspace/retention-policy`:

* `GET    /v1/workspace/retention-policy` returns the current overrides
  (`ttls_days: {}` means none).
* `PUT    /v1/workspace/retention-policy` sets `ttls_days`. Admin only,
  MFA-gated, dry-run aware. TTL range is 1 to 3650 days.
* `DELETE /v1/workspace/retention-policy` clears all overrides.
* `POST   /v1/workspace/retention-policy/sweep` runs a tenant-scoped
  sweep using the saved policy (or an ad-hoc override). Pass
  `dry_run: true` to count without deleting.

Try it locally:

```bash
# Pin prediction_audit to 30 days for this workspace.
curl -sS -X PUT http://localhost:8000/v1/workspace/retention-policy \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"ttls_days": {"prediction_audit": 30, "admin_audit_log": 365}}'

# See how many rows would be deleted right now.
curl -sS -X POST http://localhost:8000/v1/workspace/retention-policy/sweep \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"dry_run": true}'
```

## Outbound webhook destination policy (SSRF defense)

Procurement reviewers fail any SaaS that will POST to an arbitrary URL
the customer supplies. A subscription pointed at
`http://169.254.169.254/` or `http://127.0.0.1:6379/` turns the
outbound dispatcher into a confused deputy that can leak cloud-metadata
credentials or hit internal services.

The outbound subscription system now enforces a strict destination
policy at TWO points:

1. **Subscription create time** in `PUT /v1/webhooks/outbound/subscriptions`:
   bad URLs are rejected with `400 outbound_blocked` and a structured
   reason before the row is ever written.
2. **Dispatch time** in `outbound.dispatch`: DNS is re-resolved and the
   policy is re-evaluated on every send (DNS rebinding defense). When
   the policy refuses, a `WebhookDelivery` row is written with
   `state="blocked"` and no HTTP request is made; the refusal shows up
   in `GET /v1/webhooks/outbound/deliveries` and in structured logs as
   `outbound_webhook_blocked`.

Deny-by-default categories:

- Plain HTTP (set `ADHERENCE_OUTBOUND_ALLOW_HTTP=true` only in dev).
- Loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`,
  `192.168/16`, `fc00::/7`), link-local (`169.254/16`, `fe80::/10`),
  multicast, reserved, unspecified.
- URL userinfo (`http://user:pass@host`).
- Non-http/https schemes.

Always blocked, regardless of toggles:

- AWS / GCP / Azure metadata endpoints (`169.254.169.254`,
  `metadata.google.internal`, `fd00:ec2::254`).

Optional hostname allowlist via `ADHERENCE_OUTBOUND_HOST_ALLOWLIST`:
entries are exact-match (`hooks.example.com`) or suffix-match
(`.partner.io` matches any subdomain but not the bare apex).

### Try it

```bash
# Live policy snapshot.
curl -sS http://localhost:8000/v1/webhooks/outbound/policy \
  -H "x-api-key: $ADMIN_KEY"

# Dry-run a URL before creating the subscription.
curl -sS -X POST http://localhost:8000/v1/webhooks/outbound/policy/check \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"url":"http://169.254.169.254/latest/meta-data/iam/"}'
# => {"allowed":false,"reason":"cloud metadata endpoint ...","resolved_ips":[]}

# Refused at create time.
curl -sS -X PUT http://localhost:8000/v1/webhooks/outbound/subscriptions \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"name":"evil","url":"http://127.0.0.1:6379/","active":true}'
# => 400 {"detail":{"code":"outbound_blocked","reason":"..."}}
```

## Outbound webhook secret rotation with overlap window

Receivers cannot stop their consumers, swap the shared HMAC secret, and
restart in one atomic step. A naive secret rotation drops every
in-flight delivery the moment the sender starts signing with the new
key. Enterprise integrators have asked for an overlap window so they
can roll over without paging on-call.

`POST /v1/webhooks/outbound/subscriptions/{name}/rotate-secret` mints a
fresh `secrets.token_urlsafe(32)` secret and keeps the previous secret
valid for `overlap_minutes` (default 60, max 7 days, `0` is a hard cut).
While the overlap window is open every dispatched POST carries two
headers:

- `X-Adherence-Signature` signed with the new secret.
- `X-Adherence-Signature-Previous` signed with the secret being
  retired.

Receivers can keep verifying with the old secret while they roll their
stored secret over, then start trusting the new one. The new helper
`outbound.verify_any([new, old], body, header)` covers either side.

The overlap window is per subscription, time-bounded, and stops being
emitted as soon as `secret_previous_expires_at` passes. The rotation
itself is written to the admin audit log (`webhook.secret.rotate`) with
the actor, request id, and the chosen overlap. `?dry_run=true` returns
the candidate secret and window without mutating the row, so operators
can stage a rotation in a change ticket before executing it.

Only admin-scoped principals can rotate. Viewer keys get `401`/`403`,
unknown subscriptions get `404`.

### Try it

```bash
# Preview the rotation without changing anything.
curl -sS -X POST \
  "http://localhost:8000/v1/webhooks/outbound/subscriptions/clinic-1/rotate-secret?dry_run=true" \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"overlap_minutes": 60}'

# Execute the rotation with a 1-hour overlap window.
curl -sS -X POST \
  http://localhost:8000/v1/webhooks/outbound/subscriptions/clinic-1/rotate-secret \
  -H "x-api-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"overlap_minutes": 60}'
# => {"name":"clinic-1","secret":"...","secret_previous_active":true,
#     "secret_previous_expires_at":"...","rotated_at":"..."}
```

## Per-workspace seat enforcement

Every plan tier already advertised a `seats` number (free=3, pro=25,
enterprise=500) but the API would happily mint unlimited keys per
tenant. That made the plan catalog non-contractual and let one
overloaded workspace silently outgrow what billing was modeling.

Now every active API key in a workspace consumes one seat. Revoked and
expired keys do not count. `POST /v1/admin/api-keys` consults the
workspace's plan cap (plus any `seats_override`) before issuing and
returns `402 Payment Required` with a structured `seat_limit_exceeded`
body when full, including the workspace id, current usage, the cap,
and the plan name. Every rejection is written to the admin audit log
with `ok=false` so operators can see denials next to successful issuance.

Enforcement is tenant-scoped: filling acme's seats has no effect on
globex. The `/workspace/quota` page now renders a seats bar with
used/limit and shows a precise warning banner when the cap is reached.

### Try it

```bash
# After bootstrap, default tenant ships with the free plan (3 seats).
# The 4th key returns 402 with structured detail:
curl -sS -X POST http://localhost:8000/v1/admin/api-keys \
  -H "x-api-key: $ADMIN_KEY" -H "x-mfa-code: $TOTP" \
  -H "content-type: application/json" \
  -d '{"name":"svc-4","role":"service"}'
# => 402 {"detail":{"error":"seat_limit_exceeded","seats_used":3,...}}
```

## Owner-only Admin Console (single pane of glass)

Procurement scenario: a security reviewer asks "who can touch this
workspace right now, what credentials are active, and what did they do?"
The owner now answers with one screen instead of clicking through six.

`/admin` aggregates, for every workspace the caller owns:

- Members and pending invites (role, joined date)
- Active sessions across all members (IP, UA, last seen, expiry)
- API keys (prefix, scopes, last-used, revoked state)
- Last 25 dashboard-audit entries with hash-chain status
- Today's quota usage and 30-day total
- Workspace policy snapshot: SSO, enforce-SSO, session TTL, retention,
  data residency, IP allowlist

Access is gated by the `owner` role on the selected workspace. Non-owners
get `403` and a `denied` entry is written to the tamper-evident dashboard
audit log (`admin.console.view`, outcome=`denied`). Cross-tenant lookups
return `404` so the existence of other workspaces is never leaked.

- New route: `apps/web/app/api/admin/overview/route.ts`
  (owner-only, calls existing tenant-scoped stores; no new tables).
- New page: `apps/web/app/admin/page.tsx` +
  `apps/web/app/admin/client.tsx` (Phosphor duotone, shadcn-style
  primitives, loading/error/empty states, responsive at 375px and 1440px).
- New nav entry in the sidebar (`Admin // Owner console`).
- New test: `apps/web/app/api/admin/overview/__tests__/route.test.ts`
  proves anonymous=401, editor=403 with denied audit entry, cross-tenant
  owner=404, and owner sees a complete payload.

## Trust Center, SECURITY.md, security.txt

Procurement reviewers can evaluate this deployment without opening a
ticket or signing in. Three things land together:

1. **`/trust`** in the dashboard. A public, unauthenticated Trust Center
   that lists every enterprise control (SSO, RBAC, multi-tenancy, audit
   chain, rate limits, signed webhooks, residency, dry-run) and renders
   live posture from this deployment via `GET /api/trust/posture`.
   Refreshes every 60 seconds. Each control links to the in-product
   surface that operates it.
2. **`SECURITY.md`**, **`CODEOWNERS`**, **`docs/THREAT_MODEL.md`**, and
   **`docs/SUBPROCESSORS.md`** at the repo root. Vulnerability
   disclosure policy with severity tiers and response SLAs, STRIDE
   review with concrete controls, and the current subprocessor list
   with regions and notification cadence.
3. **`/.well-known/security.txt`** (RFC 9116) plus a `/security.txt`
   alias for scanners that probe the root.

The posture endpoint is the only new code path: it probes
`/livez`, `/readyz`, `/healthz`, and `/v1/audit/chain/verify` on the
upstream API, plus deterministically asserts that the dashboard's
buildSecurityHeaders contract still emits the OWASP baseline. Cached 60
seconds. No customer data, no secrets.

### Try it

```bash
cd apps/web
pnpm dev
# open http://localhost:3000/admin

# Or hit the API directly with your session cookie:
curl -H "Cookie: adh_session=..." \
  "http://localhost:3000/api/admin/overview?workspace_id=ws_xxx"
```


pnpm --filter @adherence/web dev
# dashboard: http://localhost:3000/trust
# discovery: http://localhost:3000/.well-known/security.txt
# alias:     http://localhost:3000/security.txt

curl -s http://localhost:3000/api/trust/posture | jq
```

Sample response:

```json
{
  "overall": "pass",
  "checks": [
    { "id": "liveness",         "status": "pass", "label": "API liveness probe" },
    { "id": "readiness",        "status": "pass", "label": "API readiness probe" },
    { "id": "health",           "status": "pass", "label": "Aggregate health" },
    { "id": "audit-chain",      "status": "pass", "label": "Tamper-evident audit log" },
    { "id": "security-headers", "status": "pass", "label": "Dashboard security headers" },
    { "id": "sso",              "status": "pass", "label": "Enterprise SSO (OIDC or SAML)" }
  ],
  "region": "us-east-1",
  "version": "0.1.0",
  "generated_at": "2026-05-31T17:20:00.000Z"
}
```

Test coverage: `apps/web/tests/trust-posture.test.ts` proves the route
degrades gracefully when upstream is unreachable, recognises a 401 on
the audit chain probe as evidence the route is properly guarded, and
emits the documented cache header.

## In-place API key rotation (Python admin API)

The Python admin API now supports rotating a DB-backed API key without
dropping its identity. Identity, role, scopes, tenant, IP allowlist,
note, and audit-relevant metadata are preserved so RBAC and tenant
scoping continue to apply without operator intervention. The previous
secret is invalidated atomically and the new plaintext is returned ONCE
in the response body.

Procurement scenario: a buyer's security reviewer asks "how do you
rotate a credential we suspect was leaked, without revoking and losing
the audit trail of which workspace it belongs to?". Answer:
`POST /v1/admin/api-keys/{name}/rotate`. Old secret stops working
immediately, the row keeps its tenant + scopes + IP allowlist, the
`api_key.rotate` audit event captures actor, new prefix, rotation
count, tenant, and request id.

- New `rotate_key()` in `packages/common/adherence_common/api_keys.py`
  with `rotated_at` and monotonically increasing `rotation_count` columns
  (idempotent ALTER TABLE in `db.init_db()`).
- New `POST /v1/admin/api-keys/{name}/rotate` route gated by
  `require_admin_mfa`, supports `?dry_run=true`, surfaces the new
  `rotated_at` and `rotation_count` on `GET /v1/admin/api-keys`.
- Refuses to rotate revoked keys (409) or expired keys (409) unless an
  `extend_ttl_seconds` window is supplied. Missing keys 404.
- Every rotation writes an `api_key.rotate` admin audit entry with the
  acting principal, target key name, new prefix, rotation count, tenant,
  role, scopes, and resulting expiry.
- Integration coverage in `tests/integration/test_api_key_rotation.py`
  proves: old plaintext is invalidated, identity and tenant preserved,
  `dry_run=true` does not mutate, revoked rotation is rejected, audit
  event is recorded.

### Try it

```bash
# Start the Python API locally (see Makefile target `api-dev`).
make api-dev  # serves http://127.0.0.1:8000

# Rotate a key in place. Old secret stops working immediately; the new
# plaintext is in the JSON body (last chance to read it).
curl -sS -X POST http://127.0.0.1:8000/v1/admin/api-keys/svc-ingest/rotate \
  -H "x-api-key: $ADM_KEY" -H "content-type: application/json" -d '{}'

# Dry-run preview first, no mutation.
curl -sS -X POST "http://127.0.0.1:8000/v1/admin/api-keys/svc-ingest/rotate?dry_run=true" \
  -H "x-api-key: $ADM_KEY" -H "content-type: application/json" -d '{}'
```

## Per-API-key rate-limit overrides

Enterprise customers often need one tenant to run hotter (a paid plan)
or cooler (a noisy partner that must be throttled while a deal is in
flight) than the default role tier. The Python admin API now stores an
optional token-bucket override per API key. When both `capacity` and
`refill_per_sec` are set on a key, the rate-limit middleware uses those
values instead of the role-tier defaults and books the spend in a
separate per-key bucket so changes apply on the very next request.
Clearing the override (both fields null) returns the key to the
default bucket without revocation or rotation.

- New `rate_limit_capacity` and `rate_limit_refill_per_sec` columns on
  `api_key_records` (idempotent ALTER TABLE in `db.init_db()`).
- `GET /v1/admin/api-keys/{name}/rate-limit` reports the current
  override and an `inherited` flag.
- `PUT /v1/admin/api-keys/{name}/rate-limit` installs or clears the
  override. Requires admin role plus a fresh MFA challenge, supports
  `?dry_run=true`, validates that both fields are set or both cleared,
  and writes an `api_key.rate_limit.set` admin audit entry with the
  before/after values.
- `RateLimitMiddleware` resolves the presented `x-api-key` against the
  DB and prefers the per-key override; the bucket key is suffixed with
  `:perkey` so it never bleeds into the role-tier bucket. Throttled
  responses keep the standard `Retry-After` and `X-RateLimit-*`
  headers.
- `GET /v1/admin/api-keys` surfaces the override on each row so the
  admin console can render it without an extra round trip.
- Integration coverage in
  `tests/integration/test_api_key_rate_limit_override.py` proves a key
  with a tiny custom bucket is throttled while admin and default keys
  are not, clearing restores default behavior, partial overrides are
  rejected 400, unknown keys 404, and `dry_run=true` does not persist.

### Try it

```bash
make api-dev  # serves http://127.0.0.1:8000
ADMIN="x-api-key: $ADHERENCE_ADMIN_KEY"

# Pin partner-prod to a tight bucket (5 burst, 1 token/sec sustained).
curl -sS -X PUT http://127.0.0.1:8000/v1/admin/api-keys/partner-prod/rate-limit \
  -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"capacity": 5, "refill_per_sec": 1.0}'

# Preview a change without persisting.
curl -sS -X PUT "http://127.0.0.1:8000/v1/admin/api-keys/partner-prod/rate-limit?dry_run=true" \
  -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"capacity": 25, "refill_per_sec": 5.0}'

# Clear the override and fall back to the role-tier default.
curl -sS -X PUT http://127.0.0.1:8000/v1/admin/api-keys/partner-prod/rate-limit \
  -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"capacity": null, "refill_per_sec": null}'
```

## Authentication event audit (SOC2 / SIEM)

Every authentication lifecycle event is now recorded into the same tamper
evident hash chained audit log as the rest of the dashboard mutations.
Procurement scenario: a buyer's security reviewer asks "show me every sign
in attempt for alice@acme.com in the last 90 days, including failed magic
links, SSO denials, and MFA prompts" and we can answer that in one query.

- New `apps/web/lib/auth-audit.ts` wraps the existing chain with canonical
  `auth.<verb>.<outcome>` action names (`auth.login.success`,
  `auth.mfa.failure`, `auth.sso_callback.denied`, etc).
- Wired into every auth route: `/api/auth/request`, `/api/auth/verify` (GET
  and POST), `/api/auth/sso/start`, `/api/auth/sso/callback`,
  `/api/auth/github/callback`, `/api/auth/logout`, `/api/auth/2fa/setup`,
  `/api/auth/2fa/enable`, `/api/auth/2fa/disable`, `/api/auth/2fa/verify`.
  Captures IP, user agent, actor email + user id, workspace id where known,
  and a `reason` code on every failure.
- Defence in depth: the wrapper strips forbidden keys (`token`, `code`,
  `recovery_code`, `id_token`, `access_token`, `client_secret`, etc) from
  metadata before writing, so a future contributor can't accidentally leak a
  magic token into the chain.
- Surfaced in `/audit` via a new scope dropdown (auth only, sign in, MFA,
  SSO, sign out). The hash chain validates across mixed auth and non-auth
  events; the scope filter is a pure prefix view, not a separate log.
- Audit IO never blocks the auth path: writes are best effort and swallowed
  on failure.
- Test coverage: `apps/web/tests/auth-audit.test.ts` pins the action shape,
  chain validity across interleaved namespaces, recording of failed sign
  ins, and the no-secrets contract.

### Try it

Dedicated page: <http://localhost:3000/settings/auth-events> (workspace owner cookie required). Embedded scope view also lives at <http://localhost:3000/audit>.

```bash
# Tail the auth event chain as JSONL (owner cookie required).
curl -s -b cookie.txt \
  'http://localhost:3000/api/audit/dashboard?action_prefix=auth.&limit=100&format=jsonl'

# SIEM-friendly CSV export with the same filters.
curl -s -b cookie.txt \
  'http://localhost:3000/api/audit/dashboard?action_prefix=auth.&limit=1000&format=csv' -o auth-events.csv

# Only failed sign ins in the last hour.
curl -s -b cookie.txt \
  "http://localhost:3000/api/audit/dashboard?action_prefix=auth.login.&outcome=failure&since_ms=$(($(date +%s%3N)-3600000))"
```

## Workspace data retention (GDPR / CCPA storage minimization)

Workspace owners can now declare how long stored runs (predictions, cohorts,
explanations, forecasts) live before they are auto-deleted. Procurement
scenario: a healthcare buyer requires that prediction inputs/outputs be
purged 90 days after creation; their security team needs to run an on-demand
cleanup before a SOC2 audit.

- New `runs_retention_days` field on the workspace security policy (1 to 3650,
  or null to keep forever). Owner-only, audited on change, returned in the
  policy GET so SCIM/Terraform clients can read it.
- `POST /api/retention/tick` purges runs older than the cutoff for the
  requesting workspace. Cross-tenant safe by construction: the tick can only
  delete runs whose owner is a current member of that workspace, so workspace
  A can never silently nuke workspace B's data. Supports `?dry_run=true`.
- Surfaced in the Workspace > Security UI with quick presets (30d, 90d, 1y,
  7y HIPAA) and a "Run cleanup now" button that shows how many runs were
  deleted out of how many candidates.
- Audit log entries are intentionally NOT purged. They are append-only and
  hash-chained per SOC2 guidance.
- Test coverage: `apps/web/tests/workspace-retention.test.ts` includes an
  explicit cross-tenant isolation case (Alice's 1-day retention does not
  delete Bob's runs even though they live in the same instance).

### Try it

Dashboard: <http://localhost:3000/workspace/security>

```bash
# Set 90-day retention on your workspace (owner cookie required).
curl -s -X PUT http://localhost:3000/api/workspaces/$WS/policy \
  -H 'Content-Type: application/json' \
  -b cookie.txt \
  -d '{"session_max_age_minutes":null,"require_mfa":false,"runs_retention_days":90}'

# Preview the purge without deleting anything.
curl -s -X POST "http://localhost:3000/api/retention/tick?dry_run=true" \
  -H 'Content-Type: application/json' -b cookie.txt \
  -d "{\"workspace_id\":\"$WS\"}"

# Enforce the policy now.
curl -s -X POST http://localhost:3000/api/retention/tick \
  -H 'Content-Type: application/json' -b cookie.txt \
  -d "{\"workspace_id\":\"$WS\"}"
# -> {"workspace_id":"...","retention_days":90,"cutoff_ms":...,"candidate_count":12,"deleted_count":12}
```

## Per-key source IP allowlist (CIDR-pinned API keys)

Every API key can now be restricted to a specific set of source IPs / CIDRs.
Procurement scenario: a partner is issued one service key and must call only
from their NAT egress. If the key leaks, the stolen credential is useless
from any other network.

- Stored on `api_key_records.ip_allowlist_csv` (idempotent migration; existing
  keys default to NULL = no restriction).
- Enforced in `IpAllowlistMiddleware` before any route handler runs. Blocked
  requests get a structured `403 {"error": "api_key_ip_not_allowed", ...}`
  and a `api_key_ip_allowlist_block` log line.
- IPv4 and IPv6, CIDR notation or bare IPs (auto-pinned to `/32` or `/128`).
  Honours `X-Forwarded-For` / `X-Real-IP` like the rest of the API.
- Every mutation is written to the admin audit log
  (`api_key.ip_allowlist.set`) and requires admin role + a fresh MFA challenge,
  just like key creation and revocation.
- Layered on top of the existing tenant-level allowlist. A request must pass
  both gates (key allowlist first, then tenant allowlist).

### Try it

```bash
ADMIN="x-api-key: $ADHERENCE_ADMIN_KEY"

# 1. Mint a service key for a partner.
curl -s -X POST http://localhost:8000/v1/admin/api-keys \
  -H "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"partner-prod","role":"service","scopes":["predict"]}'
# -> {"key":"ak_...","name":"partner-prod",...}

# 2. Pin the key to the partner's NAT range.
curl -s -X PUT http://localhost:8000/v1/admin/api-keys/partner-prod/ip-allowlist \
  -H "$ADMIN" -H 'Content-Type: application/json' \
  -d '{"cidrs":["10.10.0.0/16","198.51.100.7"]}'
# -> {"name":"partner-prod","cidrs":["10.10.0.0/16","198.51.100.7/32"]}

# 3. From outside the range: 403.
curl -i http://localhost:8000/v1/webhooks/medtracker/recent \
  -H 'x-api-key: ak_...' -H 'x-forwarded-for: 203.0.113.5'
# HTTP/1.1 403 Forbidden
# {"error":"api_key_ip_not_allowed","detail":"...","key":"partner-prod"}

# 4. Inspect / clear the allowlist.
curl -s http://localhost:8000/v1/admin/api-keys/partner-prod/ip-allowlist -H "$ADMIN"
curl -s -X PUT http://localhost:8000/v1/admin/api-keys/partner-prod/ip-allowlist \
  -H "$ADMIN" -H 'Content-Type: application/json' -d '{"cidrs":[]}'
```

The enforced list is also surfaced on `GET /v1/admin/api-keys` as the
`ip_allowlist` field of each row.

### Dashboard editor (Next.js)

The same per-key pin is now editable from the dashboard at `/api-keys/<id>`.
The Source IP allowlist card lists the current CIDRs, lets an operator add
or remove entries, and persists them with `PATCH /api/keys/<id>`. The
Next.js `/v1/*` routes enforce the pin on every authenticated call: predict,
batch, runs CRUD/share/export, usage, audit + audit verify, webhooks +
deliveries + redeliver, keys/me + rotate. A request whose source IP falls
outside the pin returns `403 {"detail":"source ip not allowed for this api
key"}` before any business logic runs. Empty list means "any IP" (the
workspace-level allowlist still applies).

```bash
# Pin a key from the dashboard layer.
curl -s -X PATCH http://localhost:3000/api/keys/<key_id> \
  -H 'content-type: application/json' \
  -d '{"allowed_cidrs":["10.0.0.0/8","203.0.113.42"]}'

# Used from the wrong egress: 403 in one round trip.
curl -i http://localhost:3000/v1/keys/me \
  -H 'authorization: Bearer adh_...' \
  -H 'x-forwarded-for: 198.51.100.7'
# HTTP/1.1 403 Forbidden
# {"detail":"source ip not allowed for this api key"}
```

ML risk scoring for medication adherence. Predicts which upcoming doses a user
is likely to miss in the next 24 hours and turns those scores into ranked
interventions.

## Admin TOTP MFA (RFC 6238) for privileged actions

Admin-plane mutations (issue or revoke API keys, roll back a model, sweep
audit retention) now require a second factor once an admin principal has
enrolled. Enrolment is self-service: any admin can scan the `otpauth://`
QR URI with Google Authenticator, Authy, 1Password, or Okta Verify, then
confirm with a six digit code. Confirmation issues ten single-use backup
codes for lost-device recovery.

A successful verification opens a five minute challenge window so on-call
operators do not retype the code on every request. Within that window the
FastAPI dependency `require_admin_mfa` accepts the prior verification;
outside it the endpoint returns `401` with `X-MFA-Required: totp` and the
caller resupplies via the `X-MFA-Code` header. Read-only admin endpoints
(list keys, view audit, status) stay open so incident responders are not
locked out. Failed gates, enrolments, confirmations, and verifications
are written to the hash-chained admin audit log.

Before any admin enrols, the gate is a no-op so the bootstrap key can set
MFA up without being blocked. After enrolment, the policy is
non-bypassable for that principal.

### Try it

```bash
# 1. start enrolment
curl -s -X POST http://localhost:8000/v1/admin/mfa/enroll \
     -H "x-api-key: $ADMIN_KEY" | jq .otpauth_uri
# 2. scan the otpauth URI in your authenticator, then confirm
curl -s -X POST http://localhost:8000/v1/admin/mfa/confirm \
     -H "x-api-key: $ADMIN_KEY" \
     -d '{"code":"123456"}' -H 'content-type: application/json'
# 3. subsequent mutations require X-MFA-Code (or a recent challenge)
curl -s -X POST http://localhost:8000/v1/admin/api-keys \
     -H "x-api-key: $ADMIN_KEY" \
     -H "X-MFA-Code: 654321" \
     -d '{"name":"svc-bot","role":"service"}' -H 'content-type: application/json'
```

## Workspace data residency (declared region, advertised on every response)

Workspace owners pick the declared region for their data from
`/workspace/security` (US, US-East, US-West, EU, EU-Frankfurt, EU-Ireland, UK,
CA, AP-Sydney, AP-Tokyo, AP-Singapore, or `unspecified`). The operator sets
the actual deployment region with the `ADHERENCE_DEPLOY_REGION` env var.

Every workspace-scoped response carries three headers so SIEM, DLP, and
procurement teams can verify residency without scraping the UI:

- `X-Data-Residency`: workspace-declared region
- `X-Data-Residency-Deploy`: operator-declared deployment region
- `X-Data-Residency-Match`: `match`, `mismatch`, or `unspecified`

A broader region is treated as compatible with a sub-region (workspace `eu`
plus deploy `eu-frankfurt` reports `match`). Only owners can change it; the
change is appended to the hash-chained dashboard audit log.

### Try it

```bash
ADHERENCE_DEPLOY_REGION=us-east pnpm --filter web dev
# sign in, then
curl -i http://localhost:3000/api/workspaces/<ws-id>/policy \
  -H "cookie: $YOUR_SESSION_COOKIE" | grep -i x-data-residency
```

## Per-workspace plans and prediction quota

Every workspace now belongs to a plan tier with a monthly prediction cap.
Usage is counted per UTC calendar month and resets on the first. Every
inference and forecast call charges the workspace's monthly counter and
returns the standard rate-limit headers; overage is rejected with `429`
and `Retry-After` pointing at the next month rollover. Each plan also
carries a seat cap: every active API key in a workspace consumes one
seat, and issuing a key past the cap returns `402` with a structured
`seat_limit_exceeded` body so operators see exactly which workspace and
plan are at the limit.

- Plans ship in code (`free`, `pro`, `enterprise`) and sales can set a
  custom monthly cap per workspace without changing the plan label.
- Every prediction returns `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset`, `X-Quota-Plan`, and `X-Quota-Used`.
- Plan changes are written to the admin audit log (caller, target
  workspace, before/after, IP, request id).
- Seat enforcement is tenant-scoped: filling acme's seat cap does not
  block beta from issuing keys. `GET /v1/quota/me` returns
  `seats_used` / `seats_remaining` next to monthly prediction usage, and
  the workspace quota page surfaces the seat bar inline.

Try it locally:

```bash
pnpm --filter @adherence/web dev
# Self-serve view at http://localhost:3000/workspace/quota
# Inspect headers from a prediction:
curl -i -X POST http://localhost:3000/v1/predict \
  -H "authorization: Bearer $ADH_PREDICT_KEY" \
  -H "content-type: application/json" \
  -d '{"schedule":[{"due_at":"2026-01-01T08:00:00Z","medication":"x"}]}'
# Admin: change plan or set a custom cap
curl -i -X PUT http://localhost:3000/api/admin/quota/acme \
  -H "content-type: application/json" \
  -d '{"plan":"pro","monthly_predictions_override":500000}'
# Seat cap example: free plan = 3 seats, fourth key is rejected with 402
curl -i -X POST http://localhost:8000/v1/admin/api-keys \
  -H "X-API-Key: $ADH_ADMIN_KEY" -H "content-type: application/json" \
  -d '{"name":"acme-4","role":"service","tenant_id":"acme"}'
# => HTTP/1.1 402 Payment Required
# {"detail":{"error":"seat_limit_exceeded","seats_used":3,"seats_limit":3,...}}
```

## SIEM audit log export (`/v1/audit`)

The dashboard's hash-chained audit log (settings changes, key rotations,
role changes, data exports, account erasure, webhook redeliveries) is now
readable via a public, key-authenticated endpoint so customers can ship it
straight into Splunk, Datadog, Elastic, or Panther.

- New `audit` scope on API keys. Mint a dedicated read-only SIEM key from
  Settings, API keys, with only the `audit` scope checked. Existing
  `predict` / `read` / `webhooks` keys do not gain audit access.
- `GET /v1/audit?format=ndjson&limit=500` streams entries with the standard
  `X-RateLimit-*` headers plus `X-Audit-Tip-Hash` and `X-Audit-Chain-Valid`
  so a SIEM rule can alert on tampering without parsing the body. Supported
  formats: `json` (default), `ndjson`, `jsonl`, `csv`. Supported filters:
  `action`, `actor`, `outcome`, `since` (ISO-8601 or epoch ms).
- `GET /v1/audit/verify` recomputes the SHA-256 chain across the whole log
  and returns `{ chain_valid, tip_hash, entries, checked_at }` for a daily
  SOC2 probe.
- The read does not write to the audit log itself (read access is not a
  compliance event) and does not consume predict quota.

Try it locally:

```bash
pnpm --filter @adherence/web dev
# 1. Open http://localhost:3000/api-keys and create a key with only
#    the `audit` scope checked. Copy the plaintext.
# 2. Pull entries as NDJSON for your SIEM:
curl -i 'http://localhost:3000/v1/audit?format=ndjson&limit=200' \
  -H "authorization: Bearer $ADH_AUDIT_KEY"
# 3. Daily tamper probe:
curl http://localhost:3000/v1/audit/verify \
  -H "authorization: Bearer $ADH_AUDIT_KEY"
```

Run the isolation and tamper-detection tests:

```bash
pnpm --filter @adherence/web exec vitest run tests/v1-audit.test.ts
```

## Workspace role management (owner-only, audited)

Workspace owners can promote, demote, or remove any member from the dashboard
or directly via the public API. Permission checks are enforced server-side
for every request; editors and viewers receive `403 forbidden` even if the
UI is bypassed. The last owner of a workspace cannot be demoted, mirroring
the SCIM safety rule, so a workspace cannot be stranded.

Every successful or denied role change writes to the immutable dashboard
audit log (`workspace.member.role_change`) with actor, target, before role,
after role, IP, and user agent. Member removal is audited the same way
(`workspace.member.remove`).

Try it locally:

```bash
pnpm --filter @adherence/web dev
# Open http://localhost:3000/workspace, pick a workspace, change a member's
# role from the dropdown next to their email.

# Or via the API (preview first with dry_run):
curl -X PATCH 'http://localhost:3000/api/workspaces/WS_ID?dry_run=true' \
  -H 'content-type: application/json' \
  --cookie 'adherence_session=...' \
  -d '{"user_id":"USER_ID","role":"editor"}'
```

Run the RBAC isolation test:

```bash
pnpm --filter @adherence/web exec vitest run tests/workspace-role-rbac.test.ts
```

## SCIM 2.0 user provisioning (Okta, Azure AD, Google Workspace)

Workspace owners can mint SCIM 2.0 bearer tokens that let their identity
provider create, update, and deprovision members automatically. Every token
is scoped to exactly one workspace, so a token issued for workspace A can
never read or mutate workspace B.

- RFC 7643/7644 endpoints under `/scim/v2/*`: `ServiceProviderConfig`,
  `Schemas`, `ResourceTypes`, `Users`, `Users/{id}` (GET/POST/PUT/PATCH/DELETE),
  `Groups`, `Groups/{id}` (GET/PATCH; PUT/DELETE return 403 because the
  three role groups are fixed).
- Bearer tokens are hashed at rest (sha256), shown plaintext exactly once,
  and verified with `timingSafeEqual`. Each verification updates last-used
  timestamp, IP, and use count.
- Group membership and the enterprise extension `department` attribute both
  map to internal roles (`owners`, `editors`, `viewers`). Azure AD's
  pathless PATCH shape is supported, and Okta's filter-remove
  (`members[value eq "u_..."]`) is supported on Groups. Removing a user
  from a role group sets them to `viewer` rather than deleting them, so a
  misconfigured push cannot wipe accounts.
- The last owner of a workspace cannot be demoted or deprovisioned by an
  IdP, so a misconfigured directory cannot strand a tenant.
- Every SCIM mutation writes to the hash-chained dashboard audit log with
  actor `scim:<token-id>`, source IP, and a before/after diff.
- Manage tokens at `/workspace/scim` (owner-only). Cross-tenant isolation
  is enforced by the store layer and covered by
  `apps/web/tests/scim-provisioning.test.ts` and
  `apps/web/tests/scim-groups.test.ts`.

### Try it

```bash
# 1. Sign in at http://localhost:3000, open /workspace/scim, mint a token.
# 2. Point your IdP at:
curl -H "Authorization: Bearer $SCIM_TOKEN" \
  http://localhost:3000/scim/v2/ServiceProviderConfig

# 3. Provision a user the way Okta does:
curl -X POST http://localhost:3000/scim/v2/Users \
  -H "Authorization: Bearer $SCIM_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName": "alice@acme.com",
    "active": true,
    "groups": [{"display": "editors"}]
  }'

# 4. List the three role groups your IdP can target:
curl -H "Authorization: Bearer $SCIM_TOKEN" \
  http://localhost:3000/scim/v2/Groups

# 5. Promote a user to editor by adding them to the editors group
#    (this is exactly what Okta and Azure AD send on a role assignment):
curl -X PATCH "http://localhost:3000/scim/v2/Groups/$WORKSPACE_ID:editors" \
  -H "Authorization: Bearer $SCIM_TOKEN" \
  -H "Content-Type: application/scim+json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [
      {"op": "add", "path": "members", "value": [{"value": "u_bob"}]}
    ]
  }'
```

## Active sessions: per-device list and revoke

Every sign-in (magic link, SSO, GitHub OAuth, post-2FA) now mints a
server-tracked session record alongside the signed HMAC cookie. Owners can
see every browser currently signed into their account and revoke any one
of them without nuking the whole generation.

- `GET /api/auth/sessions/list` returns one row per non-revoked, non-expired
  session with label (`magic-link` / `sso` / `github` / `2fa` /
  `revoke-all`), last IP, user agent, created and last-seen timestamps, plus
  a `current_sid` field so the UI can mark the calling device.
- `DELETE /api/auth/sessions/revoke/:sid` revokes one session. Cross-account
  revoke is impossible because `revokeSession()` filters by `user_id` at the
  store layer; the request also refuses to revoke the caller's own current
  cookie (that is the sign-out path). Every call is written to the
  hash-chained dashboard audit log as `session.revoke` (success / denied).
  Honours `?dry_run=true`.
- `POST /api/auth/sessions/revoke-all` keeps its existing "sign out
  everywhere" semantics and now also flips every per-session record (with
  optional `keep_current`) and writes a `session.revoke_all` audit entry.
- Account erasure (`DELETE /api/auth/account`) calls `purgeSessionsForUser`
  so deleted users leave no orphan session rows behind.
- Settings UI lives at `/settings/sessions`: phosphor-duotone device icons,
  responsive at 375px and 1440px, loading skeletons, empty + error states,
  and a `Sign out everywhere` card that only fires when there is at least
  one other session.

Cross-user isolation is covered by `apps/web/lib/__tests__/sessions-store.test.ts`:
alice cannot revoke bob's session, bob's session survives alice's purge, and
revoked rows disappear from `getSessionRecord` on next read.

Try it:

    pnpm --filter @adherence/web dev
    # sign in at http://localhost:3000/login, open http://localhost:3000/settings/sessions
    # or hit the API directly:
    curl -s http://localhost:3000/api/auth/sessions/list \
      --cookie "adh_session=$YOUR_COOKIE" | jq
    curl -s -X DELETE http://localhost:3000/api/auth/sessions/revoke/$SID \
      --cookie "adh_session=$YOUR_COOKIE"

## Right to erasure: delete your account

Settings now has a dedicated GDPR Article 17 / CCPA self-service path that
hard-deletes the signed-in user end-to-end, not just the workspace data.
The flow:

- `GET /api/auth/account` returns a preview: every workspace the user
  belongs to, tagged `leave`, `delete_workspace`, or `blocked` (sole owner
  of a workspace with other members).
- `DELETE /api/auth/account` with body `{ "confirm": "DELETE MY ACCOUNT" }`
  refuses if any membership is blocked, otherwise:
  - tombstones every note the user authored (PII scrubbed, run history kept),
  - removes every workspace membership and tears down any workspace they
    owned alone,
  - bumps `session_gen` so every outstanding cookie is rejected immediately,
  - deletes the user record and every unconsumed magic-link token,
  - lands one immutable entry in the hash-chained dashboard audit log
    (`account.delete`, success / denied / failure), and
  - clears the session cookie on the response.
- `DELETE /api/auth/account?dry_run=true` returns the same preview shape
  with the standard `X-Dry-Run` headers so SCIM / IT runbooks can stage the
  call before pulling the trigger.

The Settings page surfaces this as its own danger-zone card next to the
existing workspace wipe. The cross-tenant isolation invariant is covered
by `tests/account-erase.test.ts`: erasing alice leaves bob, his notes, and
any workspace he co-owns untouched.

Try it:

    pnpm --filter @adherence/web dev
    # sign in at http://localhost:3000/login, then in another shell:
    curl -i http://localhost:3000/api/auth/account \
      --cookie "adh_session=$YOUR_COOKIE"
    # then to actually erase:
    curl -i -X DELETE http://localhost:3000/api/auth/account \
      --cookie "adh_session=$YOUR_COOKIE" \
      -H 'content-type: application/json' \
      -d '{"confirm":"DELETE MY ACCOUNT"}'

## Standard rate-limit headers on every /v1 response

Every `/v1/*` endpoint now emits IETF-style rate-limit headers on success
responses and a real `Retry-After` value on 429s, sourced from a single
helper (`apps/web/lib/v1-ratelimit.ts`). One source of truth, two rings
(plan + per-key) reconciled into a binding limit, no more bespoke header
names per route. SDKs and load balancers can back off correctly without
any custom integration.

- `X-RateLimit-Limit` binding daily cap (min of plan vs per-key)
- `X-RateLimit-Remaining` remaining requests for that binding ring after this call
- `X-RateLimit-Reset` unix seconds when the UTC day rolls over
- `X-RateLimit-Scope` `plan` or `api_key` so callers know which ring is binding
- `X-RateLimit-Plan-Limit` / `X-RateLimit-Plan-Remaining` workspace plan ring
- `X-RateLimit-Key-Limit` / `X-RateLimit-Key-Remaining` per-key cap (when set)
- `Retry-After` (on 429) integer seconds to UTC midnight, never zero, never the old hard-coded 3600

The `/v1/keys/me` read endpoint reports the current budget without
charging a unit, so a customer's CI can poll headroom safely.

Try it:

    pnpm --filter @adherence/web dev
    # mint a key from /keys, then:
    curl -i http://localhost:3000/v1/keys/me \
      -H "authorization: Bearer adh_..." | grep -i 'x-ratelimit\|retry-after'
    # force a 429 by setting daily_quota=1 on the key and calling /v1/predict twice

![landing](docs/screenshots/landing.png)

## Observability for the dashboard (health, metrics, request IDs)

The Next.js dashboard now ships the same three probes the FastAPI service
already exposed, so a procurement reviewer can wire both processes into
the same Kubernetes + Prometheus + log-aggregator stack without a custom
integration.

- `GET /healthz` returns 200 with process metadata (version, node, uptime).
  Cheap. Hit it from your liveness probe.
- `GET /readyz` returns 200 only when the upstream FastAPI API answers
  `/livez` within 1.5 s; otherwise 503 so the load balancer drains the
  pod. Use it for `readinessProbe`.
- `GET /metrics` exposes Prometheus text exposition with build info,
  process uptime, RSS memory, and upstream call counters plus latency
  histograms (`dashboard_upstream_request_duration_ms_bucket{outcome,le}`).
  Scope this with a network policy in production; there is no auth.
- Every request gets a stable `x-request-id` (the caller's id is kept if
  it matches `[A-Za-z0-9_-]{6,128}`, otherwise a fresh 24-char id is
  minted). The header is echoed on the response and one structured JSON
  access log line is emitted to stdout per request, ready for any log
  shipper.
- `lib/api.ts` records every upstream call into the same metrics store
  so the histogram reflects real dashboard traffic.

Try it:

    pnpm --filter @adherence/web dev
    curl -i http://localhost:3000/healthz
    curl -s http://localhost:3000/metrics | head -20
    curl -i -H 'x-request-id: trace-abc-123' http://localhost:3000/login | grep -i x-request-id

## Outbound webhook SSRF guard

Workspace owners control where webhook deliveries are allowed to go from
`/workspace/security`. By default the dispatcher refuses to POST to loopback,
RFC1918, link-local, multicast, broadcast, and the AWS/GCP/Azure metadata IPs
(169.254.169.254 and friends). Owners can:

- toggle `allow_private_networks` for closed-network self-hosted sinks
- pin destinations to a host allowlist (`hooks.acme.com`, `.acme.com`)

Enforcement happens in three places: at `createEndpoint` time (sync preflight
on the URL literal), on every `dispatch` attempt (re-resolves DNS to defeat
rebinding), and the metadata IP block is unconditional even when private
networks are allowed. Blocked deliveries surface as `422 ssrf_blocked` from
the API and as a `webhook.failed` notification in the dashboard. Covered by
`tests/webhook-ssrf.test.ts`.

## Workspace security policy (session TTL + require MFA)

Owners cap the maximum session lifetime and force every member to enroll
TOTP from `/workspace/security`. Enforcement runs at three layers so a
tightened policy applies immediately:

- `buildSession` caps the cookie `exp` to the smallest
  `session_max_age_minutes` across every workspace the user belongs to.
- `getSession` re-evaluates the policy on every request and rejects
  already-minted long-lived cookies whose `iat` is now out of range.
- `/api/auth/verify`, `/api/auth/sso/callback`, and
  `/api/auth/github/callback` refuse to mint a session when `require_mfa`
  is on and the user has no TOTP factor (redirect to `?error=mfa_enrollment_required`).

When a user belongs to multiple workspaces the tightest rule wins: lowest
session cap, and `require_mfa` true if any workspace requires it. Every
update is appended to the hash-chained dashboard audit log
(`workspace.policy.update`) with the full before/after diff so a CISO can
verify the timeline.

Try it:

    pnpm --filter @adherence/web dev
    # UI: http://localhost:3000/workspace/security
    # API (owner cookie required):
    curl -i -X PUT http://localhost:3000/api/workspaces/<WS_ID>/policy \
      -H 'content-type: application/json' \
      -b adh_session=<your-cookie> \
      -d '{"session_max_age_minutes":480,"require_mfa":true}'
    # Dry-run preview without saving:
    curl -s -X PUT 'http://localhost:3000/api/workspaces/<WS_ID>/policy?dry_run=true' \
      -H 'content-type: application/json' \
      -b adh_session=<your-cookie> \
      -d '{"session_max_age_minutes":60,"require_mfa":false}'

## Single sign-on (OIDC) per workspace

Workspace owners can route their members through Google Workspace, Okta,
Azure AD, Auth0, or any OIDC-compliant identity provider. SSO is enforced
at the *email-domain* level: when `enforce` is on, magic-link sign-in and
GitHub OAuth are both refused for the workspace's claimed domains and the
login page automatically shows a "Continue with {provider}" button.

The implementation is dependency-free: discovery via
`{issuer}/.well-known/openid-configuration`, authorization code flow with
PKCE (S256) and HMAC-signed state cookie, `id_token` signature verified
directly against the issuer's JWKS (RS256/RS384/RS512/ES256/ES384) with
`iss`, `aud`, `exp`, and `nonce` checks. The client secret never leaves
the server (the dashboard reports `has_client_secret: true/false` only).

Manage it from `/workspace/sso`. The same enforcement runs at three
layers so a half-rolled-out config can't be bypassed:

- `/api/auth/sso/discover` so the login page can show the SSO button
  before a password is typed.
- `/api/auth/request` (magic link) returns `403 sso_required` with a
  `start_url` pointing the user to their IdP.
- `/api/auth/verify` (magic-link landing) and `/api/auth/github/callback`
  re-check enforcement at session-mint time so links issued before SSO
  was enforced can't be used after.

Try it:

    pnpm --filter @adherence/web dev
    # http://localhost:3000/workspace/sso
    # configure: issuer https://accounts.google.com, your client_id /
    # client_secret, allowed_email_domains=[your-domain.com], enforce=true
    curl -i -X POST http://localhost:3000/api/auth/request \
      -H 'content-type: application/json' \
      -d '{"email":"you@your-domain.com"}'
    # => HTTP/1.1 403
    # => {"error":{"code":"sso_required",...},"sso":{"start_url":"/api/auth/sso/start?workspace=ws_...",...}}

## API-side OIDC for machine-to-machine clients

The FastAPI service can also accept third-party OIDC ID tokens directly,
for CLI users, CI jobs, and partner integrations that already hold a
Google Workspace, Okta, or Azure AD token but don't want a long-lived
API key. The ID token is verified against the IdP's JWKS (RS256 / ES256
families, `iss`, `aud`, `exp`, `email_verified` enforced) and exchanged
for a short-lived internal JWT. Every exchange is written to
`admin_audit_log` so security teams can review SSO sign-ins alongside
token mints and key rotations.

Configure via environment:

    ADHERENCE_OIDC_PROVIDERS="google:1234567890.apps.googleusercontent.com"
    ADHERENCE_OIDC_ISSUERS="google:https://accounts.google.com"
    ADHERENCE_OIDC_DOMAIN_ROLE_MAP="acme.com:admin,partner.io:viewer"
    ADHERENCE_OIDC_DOMAIN_TENANT_MAP="acme.com:acme,partner.io:partner"
    ADHERENCE_OIDC_REQUIRE_DOMAIN_MATCH=true   # reject unmapped domains
    ADHERENCE_OIDC_REQUIRE_VERIFIED_EMAIL=true # default on

Try it locally (API on :8000):

    # 1. List configured providers (safe to call from a sign-in page;
    #    audience is suffix-only in the response)
    curl http://localhost:8000/v1/admin/sso/providers

    # 2. Exchange a real ID token from your IdP for an internal JWT
    curl -X POST http://localhost:8000/v1/admin/sso/oidc/exchange \
      -H 'content-type: application/json' \
      -d '{"provider":"google","id_token":"<paste id_token here>"}'
    # => {"token":"eyJ...","expires_in":3600,"role":"admin","tenant":"acme",...}

    # 3. Use the minted token like any other bearer credential
    curl http://localhost:8000/v1/health -H 'authorization: Bearer eyJ...'

## Dashboard audit log

Every mutating dashboard action (settings change, workspace export, full
wipe) now lands in a hash-chained, append-only audit log so security teams
can reconstruct who changed what, when, and from which IP. Each entry links
to the previous one by SHA-256, so any tampered row flips the chain status
to broken in the UI.

## Enterprise dry-run mode

Every destructive endpoint accepts `?dry_run=true` (or `X-Dry-Run: true`)
and returns a server-authored preview of what the call would do without
touching any state. Responses set `X-Dry-Run: true` and a uniform JSON
envelope (`{ dry_run, would, preview: { resource, id, summary, cascade,
before } }`) so change-control review can show operators exactly which
rows would be removed and which cascades they trigger. Coverage:

- `DELETE /api/keys/:id` (revoke API key)
- `DELETE /api/webhooks/:id` (delete endpoint, lists orphaned delivery rows)
- `DELETE /api/runs/:id` (delete saved prediction)
- `DELETE /api/shares/:id` (revoke public share link)
- `DELETE /api/saved-searches/:id`
- `DELETE /api/schedules/:id`
- `DELETE /api/workspaces/:id?user_id=` (remove member)
- `DELETE /api/workspaces/:id/invites?invite_id=` (revoke pending invite)
- `DELETE /api/notifications/:id` (dismiss personal notification)
- `POST /api/settings/wipe` (GDPR data wipe, reports total bytes + file list)

The API Keys page calls the dry-run path before every revoke and surfaces
the server summary in the confirmation prompt, so the same review story
works from the dashboard.

### FastAPI service-side dry-run (`/v1/...`)

The FastAPI control plane mirrors the same contract on every destructive
route the dashboard does not own directly. Each accepts a `?dry_run=true`
query parameter and, when set, returns
`{ "dry_run": true, "would_<verb>": true, ... }` without mutating, deleting,
or revoking anything. A missing target still returns HTTP 404 so previews
cannot leak existence across tenants. Admin-audited routes still write an
audit entry with `details.dry_run = true` so SOC2 reviewers can see who
probed what. Coverage:

- `DELETE /v1/users/{user_id}/mute`
- `DELETE /v1/users/{user_id}/data` (GDPR erase, returns candidate counts)
- `DELETE /v1/webhooks/outbound/subscriptions/{name}`
- `DELETE /v1/policies/risk?scope_type=&scope_id=`
- `DELETE /v1/policies/quiet-hours/{user_id}`
- `DELETE /v1/policies/notification-budget/{user_id}`
- `DELETE /v1/admin/ip-allowlist/{entry_id}`
- `POST   /v1/admin/api-keys/{name}/revoke?dry_run=true`

Try it:

```bash
# Preview a GDPR erase (per-table candidate counts, no rows deleted)
curl -s -X DELETE \
  'http://localhost:8000/v1/users/USER_ID/data?dry_run=true' \
  -H "x-api-key: $ADM_KEY" | jq

# Preview an API key revoke (audit entry tagged dry_run=true)
curl -s -X POST \
  'http://localhost:8000/v1/admin/api-keys/legacy-cron/revoke?dry_run=true' \
  -H "x-api-key: $ADM_KEY" | jq
```

Destructive endpoints (`/api/settings/wipe`) also still require an explicit
confirm string for the real call.

The entries are surfaced at the bottom of the existing Audit page, with
filters by action and outcome, and a one-click `.jsonl` export for SIEM
ingestion. All three settings endpoints (`GET /api/settings` is read-only
and stays open) require a signed session unless
`ADHERENCE_DASHBOARD_OPEN=1` is set for solo local development.

Try it:

```bash
# UI: see the panel under the prediction audit
open http://localhost:3000/audit

# API: list recent entries (session cookie required)
curl -s --cookie 'adh_session=...' \
  'http://localhost:3000/api/audit/dashboard?limit=50&outcome=denied' | jq

# Dry-run a wipe without deleting anything (no confirm needed for previews)
curl -s -X POST 'http://localhost:3000/api/settings/wipe?dry_run=true' | jq

# Dry-run an API key revoke (cookie-authed dashboard route)
curl -s -X DELETE 'http://localhost:3000/api/keys/KEY_ID?dry_run=true' | jq

# Export the chain for offline review
curl -s --cookie 'adh_session=...' \
  'http://localhost:3000/api/audit/dashboard?format=jsonl' \
  -o dashboard-audit.jsonl
```

## IP allowlist

Workspace admins can pin API and dashboard access to a list of trusted IPs
or CIDR ranges. When zero entries exist the gate is off, so first installs
are never bricked. As soon as one row is added, every request whose client
IP falls outside the list is rejected with HTTP 403 `ip_not_allowed` and
the block is recorded in the admin audit log.

Try it:

```bash
# UI
open http://localhost:3000/settings/ip-allowlist

# API (admin session cookie or admin JWT)
curl -s http://localhost:8000/v1/admin/ip-allowlist | jq
curl -s -X POST http://localhost:8000/v1/admin/ip-allowlist \
  -H 'content-type: application/json' \
  -d '{"cidr":"203.0.113.0/24","label":"office egress"}'
```

Health, metrics, and OpenAPI endpoints stay exempt so operator probes
keep working even when a tenant is fully locked down.

## What it does

The service ingests scheduled-dose events from a med-tracker source, builds
per-user temporal features, and trains an XGBoost + LightGBM ensemble whose
probabilities are calibrated (isotonic) before serving. The FastAPI app exposes
`/v1/predict` for single users and `/v1/cohort/risk` for population sweeps,
plus online quality metrics (AUC, Brier, log-loss, calibration drift) under
`/v1/metrics`. Per-dose SHAP attributions are returned at predict time and
aggregated globally under `/v1/explain`. High-risk doses can be fanned out into
a notification queue with risk-tier policies, quiet hours, per-user mutes, and
notification budgets. Every prediction, override, and delivery is recorded in
an append-only audit log with CSV export.

### IP allowlist

Workspace owners can restrict API and dashboard traffic to a list of
trusted IPs and CIDR ranges from
[/settings/ip-allowlist](http://localhost:3000/settings/ip-allowlist). Each
entry is scoped to the caller's tenant (`tenant_ip_allowlist` table) and
enforced by `IpAllowlistMiddleware` on every API route. Health,
readiness, Prometheus metrics, and OpenAPI endpoints stay reachable so
operator probes keep working even when the workspace is locked down.
Blocked requests return HTTP 403 with `error: ip_not_allowed`. Add and
remove operations write to the admin audit log.

Try it locally with the dev admin key:

```bash
curl -s http://127.0.0.1:8000/v1/admin/ip-allowlist -H 'x-api-key: dev-admin-key'
curl -s -X POST http://127.0.0.1:8000/v1/admin/ip-allowlist \
  -H 'x-api-key: dev-admin-key' -H 'content-type: application/json' \
  -d '{"cidr":"10.0.0.0/24","label":"office"}'
```

### Weekly digest

Visit [/digest](http://localhost:3000/digest) for a 7-day activity summary
(runs, top tags, recent titles, week-over-week delta) plus a live HTML
email preview that mirrors what gets sent to the contact email set in
[/settings](http://localhost:3000/settings). The page renders the same
payload the email job uses, includes a 7-day bar chart, and records every
delivery to `.data/digest-sent.json` so you can audit when each digest
went out. Toggle the schedule with the *Weekly activity digest* switch
in Settings; wire a real transport by POSTing the output of
`renderDigestHtml()` to Resend/SES/SMTP inside
`apps/web/app/api/digest/route.ts`.

### Usage and quota

Every `/v1/predict` call is metered against the workspace's active plan
(see `/billing` and `/pricing`). The free tier ships with a 500
requests/day quota (override with `ADHERENCE_FREE_DAILY_QUOTA`). When the
limit is reached the endpoint returns `429` with `x-quota-*` headers and an
`upgrade_url`. Browse the live meter, 30-day request sparkline, and per-key
breakdown at [http://localhost:3000/usage](http://localhost:3000/usage).
Every 200 response carries `x-quota-limit`, `x-quota-used`, and
`x-quota-remaining` so clients can back off before getting throttled.

### Billing and plans

Three self-serve tiers ship in the UI: Free (500 req/day), Pro (25,000
req/day, $49/mo), and Scale (250,000 req/day, $299/mo). Override the
quota numbers with `ADHERENCE_PRO_DAILY_QUOTA` and
`ADHERENCE_SCALE_DAILY_QUOTA`. Visit
[/pricing](http://localhost:3000/pricing) to compare plans and
[/billing](http://localhost:3000/billing) to see the current plan, today's
usage against the new quota, and a change history. Plan changes apply
immediately to `/v1/predict` quota gating, no restart required.

No Stripe key is required to use the flow as shipped: `POST
/api/plan/checkout` records the plan change server side and redirects back
to `/billing?session=<id>`. To wire real payments, replace the body of
`apps/web/app/api/plan/checkout/route.ts` with a Stripe Checkout Session
create call and move the `changePlan` call into a
`checkout.session.completed` webhook handler. The UI does not change.

### Sign in (magic link)

The web app now ships with passwordless email sign-in. Visit
[/login](http://localhost:3000/login), enter your email, and click the link.
Sessions are signed cookies (HMAC-SHA256, 30 day expiry) and persist across
restarts. Set `ADHERENCE_SESSION_SECRET` (16+ chars) in production. In
development the magic link is also surfaced inline on the login page and
logged to stdout so you do not need SMTP wired up to try the flow.

Try it locally:

```bash
# 1. request a link (dev mode echoes it back)
curl -s -X POST http://localhost:3000/api/auth/request \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'

# 2. follow the dev_link from the response, or open /login in a browser

# 3. confirm the session
curl -s -b cookies.txt http://localhost:3000/api/auth/me
```

The user's email + sign-out control live in the sidebar footer. Anonymous
visitors see a Sign in chip instead.

### Sign in with GitHub

The login page also supports GitHub OAuth as a one-click alternative to
the magic link. To enable it, register an OAuth app at
`https://github.com/settings/developers` with the callback URL
`https://<your-host>/api/auth/github/callback`, then set:

```bash
export GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
export GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export ADHERENCE_SESSION_SECRET=$(openssl rand -hex 32)
```

When those are present the *Continue with GitHub* button appears on
[/login](http://localhost:3000/login). The flow uses a signed,
HMAC-SHA256 state cookie (10 minute TTL) to prevent CSRF, then reads the
user's verified primary email via the GitHub API (`read:user user:email`
scopes only, no repo access). First-time users are created on the fly
and share the same `adh_session` cookie + sidebar footer as magic-link
sign-ins. If neither client id nor secret is set the button is hidden
and the route returns the user to `/login?error=oauth_unconfigured`.

### Get started in three steps

New workspaces land on [/onboarding](http://localhost:3000/onboarding): a guided
first-run wizard that seeds three sample patient runs, a revoked sample API
key for the curl example, and an inactive demo webhook, then walks the
operator through issuing a real key and saving their first scored patient.
Progress is tracked in `ADHERENCE_DATA_DIR/onboarding.json` and survives
restarts. Try it:

```bash
curl -sS -X POST http://localhost:3000/api/onboarding/seed | jq .
curl -sS http://localhost:3000/api/onboarding | jq .
```

### Install as an app

The web app ships a `manifest.webmanifest`, themed icons, and a dismissible
install chip. On Chrome, Edge, and Android the chip surfaces the native
`beforeinstallprompt`; on iOS Safari it nudges users to use Share then Add
to Home Screen. Dismissals are remembered for 14 days. Launching from the
home screen runs the app standalone with the existing dark theme.

The installed app also registers a service worker (`apps/web/public/sw.js`)
that precaches the app shell plus `/offline`, serves static `_next/static`
assets stale-while-revalidate, and falls back to a branded offline page for
navigations when the network is down. Mutating APIs under `/api/*` and
`/v1/*` are never cached, so predictions and run history stay live. When a
new worker version takes control the UI surfaces a small "new version
ready, reload" chip.

### Two-factor authentication (TOTP)

Visit [/settings/security](http://localhost:3000/settings/security) to add a
second factor to your account. The flow is dependency-free RFC 6238 TOTP:
set up generates a fresh 160-bit base32 secret, surfaces an `otpauth://` URI
plus a manual-entry key for any authenticator app (1Password, Authy, Google
Authenticator, Bitwarden), and only flips 2FA on after the first valid
6-digit code. Confirming the code mints ten one-time recovery codes that you
can download as `.txt`. The next sign-in (magic link or GitHub OAuth) issues
a short-lived `adh_mfa_pending` cookie and bounces through
[/verify-2fa](http://localhost:3000/verify-2fa) before any real session
cookie is set, so a stolen inbox is no longer enough on its own.

```bash
# After signing in normally:
curl -s -b 'adh_session=...' http://localhost:3000/api/auth/2fa/status
curl -s -X POST -b 'adh_session=...' http://localhost:3000/api/auth/2fa/setup
curl -s -X POST -b 'adh_session=...' http://localhost:3000/api/auth/2fa/enable \
  -H 'content-type: application/json' -d '{"code":"123456"}'
```

Disabling 2FA requires a current authenticator code or one of the recovery
codes, so a stolen session cookie cannot silently turn the second factor
off.

### Force sign out every device

If a laptop walks off or you suspect a session cookie has leaked, open
[/settings/security](http://localhost:3000/settings/security) and hit **Sign
out all other sessions**. Every cookie ever issued to your account is
rejected on the next request, including the long-lived ones on other
devices. Your current browser stays signed in (a fresh cookie is re-minted
in the same response) so you do not lock yourself out mid-incident. Use the
*also sign out this browser* link to invalidate the active tab too.

Under the hood each `UserRecord` carries a `session_gen` counter; signed
session cookies embed a `gen` claim, and `getSession` rejects cookies whose
`gen` is below the user's current generation. Revocation is therefore
instant across every server process without a shared cache.

```bash
# inspect the current session and last revocation timestamp
curl -s --cookie adh_session=$COOKIE http://localhost:3000/api/auth/sessions/status | jq

# revoke every outstanding session, keep this browser signed in
curl -s -X POST --cookie adh_session=$COOKIE \
  -H 'content-type: application/json' \
  -d '{"keep_current":true}' \
  http://localhost:3000/api/auth/sessions/revoke-all
```

### Settings and your data

Visit [/settings](http://localhost:3000/settings) for the workspace profile
(display name, contact email, org, timezone), notification preferences
(high-risk email, weekly digest, webhook master switch, slow-run toast), and
the data controls. Hit `download .json` to pull a single bundle with every
run, API key (hashes only), usage day-bucket, share link, webhook endpoint,
and delivery attempt. The danger zone wipes every file under
`ADHERENCE_DATA_DIR` after you type the confirmation phrase, so a customer
can honor a GDPR delete request with one click. Try it:

```bash
curl -s http://localhost:3000/api/settings | jq .
curl -s http://localhost:3000/api/settings/export -o adherence-export.json
curl -s -X POST http://localhost:3000/api/settings/wipe \
  -H 'content-type: application/json' \
  -d '{"confirm":"DELETE EVERYTHING"}'
```

### Notifications

An in-app activity feed lives at
[/notifications](http://localhost:3000/notifications) with an unread-badge bell
in the sidebar header. New entries land automatically when a run is saved, a
batch job finishes, or a webhook delivery exhausts its retries. The bell
polls every 30 seconds. Broadcasts (operator announcements with `user_id` of
`null`) are visible to every account but the read state is tracked per user
so marking one read does not silence it for everyone else. Try it:

```bash
curl http://localhost:3000/api/notifications
curl -X POST http://localhost:3000/api/notifications/<id>/read
curl -X POST http://localhost:3000/api/notifications/read-all
```

### Inbound webhooks (HMAC verified)

Partner systems (Med-Tracker, EHR adapters) post ground-truth dose outcomes
to `POST /v1/webhooks/medtracker/event` on the FastAPI service. Each
outcome row is stamped with a `tenant_id` at write time using the
operator-supplied `ADHERENCE_INBOUND_SOURCE_TENANTS` mapping so that
`/v1/metrics/online`, `/v1/metrics/online/report`, and the calibration
drift endpoint can never join one workspace's predictions against
another workspace's ground-truth events. Rows for a source with no
mapping fall back to the deployment default tenant. Existing rows are
backfilled from `prediction_audit` on first boot of the upgraded code.
Because
those rows feed online metrics and challenger-model promotion, the endpoint
verifies an HMAC envelope when a per-source secret is configured. Configure
secrets with:

```bash
export ADHERENCE_INBOUND_WEBHOOK_SECRETS="medtracker:CHANGE_ME,partnerX:..."
export ADHERENCE_INBOUND_WEBHOOK_MAX_SKEW_SECONDS=300
# Optional: hard-reject any source that has no secret configured.
export ADHERENCE_INBOUND_WEBHOOK_REQUIRE_SIGNED=true
```

Headers the partner must send:

```
X-Webhook-Timestamp: <unix seconds>
X-Webhook-Signature: sha256=<hex(hmac_sha256(secret, ts + "." + raw_body))>
```

Try it locally:

```bash
BODY='{"source":"medtracker","events":[{"event_id":"evt-1","user_id":"u_000001","dose_id":"d1","scheduled_at":"2026-03-05T08:00:00Z","outcome":"taken"}]}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "CHANGE_ME" | awk '{print $2}')"
curl -s -X POST http://localhost:8000/v1/webhooks/medtracker/event \
  -H "x-api-key: $ADHERENCE_SERVICE_KEY" \
  -H "X-Webhook-Timestamp: $TS" -H "X-Webhook-Signature: $SIG" \
  -H 'content-type: application/json' --data "$BODY"
```

Bad signature, stale timestamp, or a missing header all return `401`.
Unsigned partners are accepted only while no secret is configured for them
and are logged as `inbound_webhook_unsigned` so operators can see them.

### Webhooks

Register an HTTP endpoint and adherence.ml will POST a signed JSON envelope to
it every time a run is recorded. Useful for piping risk scores into Slack,
your own analytics, or a downstream nudge engine. Manage endpoints at
[http://localhost:3000/webhooks](http://localhost:3000/webhooks). Endpoints,
attempt history, and counters live in `apps/web/.data/webhooks.json`. The
signing secret is shown exactly once at creation; only a SHA-256 hash is
persisted. Failed deliveries retry with exponential backoff (4 attempts over
~40s) and the last 500 attempts are kept in a delivery log. The /webhooks
page exposes one-click **CSV / NDJSON download** of the current delivery view
(scoped by status filter and endpoint), or hit
`GET /api/webhooks/deliveries/export?format=csv&status=failed&limit=500`
directly for postmortem analysis in Excel, Splunk, or duckdb.

Signature header: `X-Adherence-Signature: t=<unix>,v1=<hex>` where
`v1 = HMAC_SHA256(secret_hash, t + "." + raw_body)`. Receivers should reject
requests where `|now - t| > 300s`.

```bash
# 1. register an endpoint, copy the returned `secret`
curl -X POST http://localhost:3000/api/webhooks \
  -H "content-type: application/json" \
  -d '{"name":"slack relay","url":"https://example.com/hooks/adherence"}'

# 2. trigger a real delivery by creating any run
curl -X POST http://localhost:3000/api/runs \
  -H "content-type: application/json" \
  -d '{"kind":"demo","title":"hello","payload":{}}'

# 3. tail the delivery log (filter by status: all|ok|failed|pending)
curl 'http://localhost:3000/api/webhooks/deliveries?status=failed' | jq

# 4. inspect a single delivery (payload + per-attempt status, duration, error)
curl http://localhost:3000/api/webhooks/deliveries/del_XXXX | jq

# 5. redeliver a failed one against its original endpoint (new delivery row,
#    original is preserved for comparison; test pings are excluded)
curl -X POST http://localhost:3000/api/webhooks/deliveries/del_XXXX/redeliver | jq

# 6. programmatic replay over the public v1 surface (requires the 'webhooks'
#    scope). Add ?dry_run=true to preview without dispatching.
curl -X POST http://localhost:3000/v1/webhooks/deliveries/del_XXXX/redeliver \
  -H "authorization: Bearer adh_..." | jq
```

The `/api` dashboard route is session-protected and writes every replay to
the tamper-evident dashboard audit log (actor, source delivery, endpoint,
outcome). The `/v1` route is API-key authenticated, scope-gated, supports
`?dry_run=true` for change-control review, and emits the standard
`X-RateLimit-*` headers like every other billable endpoint.

The `/webhooks` dashboard now ships status filter chips, expandable rows
showing the full payload plus per-attempt log, and a one-click `redeliver`
button on every non-test delivery.

#### Webhooks API (key authenticated)

The same endpoints are reachable from outside the browser using an API key
with the `webhooks` scope. Mint a key at
[/api-keys](http://localhost:3000/api-keys) with `webhooks` checked, then:

```bash
# list endpoints
curl http://localhost:3000/v1/webhooks \
  -H "authorization: Bearer adh_..."

# register a new endpoint (response includes `secret` exactly once)
curl -X POST http://localhost:3000/v1/webhooks \
  -H "authorization: Bearer adh_..." \
  -H "content-type: application/json" \
  -d '{"name":"prod","url":"https://example.com/hook","events":["run.created"]}'

# tail deliveries (status: all|ok|failed|pending)
curl 'http://localhost:3000/v1/webhooks/deliveries?status=failed&limit=20' \
  -H "authorization: Bearer adh_..."

# delete an endpoint
curl -X DELETE http://localhost:3000/v1/webhooks/<id> \
  -H "authorization: Bearer adh_..."
```

GET requests also accept the existing `read` scope so dashboards can audit
endpoints and deliveries without holding write power. Every call is recorded
in per-key usage at [/api-keys/&lt;id&gt;](http://localhost:3000/api-keys).

### API keys

Issue your own keys for the public `/v1/predict` endpoint and call it from
anywhere. Create, copy, and revoke keys at
[http://localhost:3000/api-keys](http://localhost:3000/api-keys). Keys are
shown exactly once at creation; only a SHA-256 hash and a short prefix are
persisted to `apps/web/.data/api-keys.json`. Each successful call records
last-used and increments a counter, and lands in the same run history under
the `v1` tag.

**API reference at /docs.** Every `/v1` route is documented at
[http://localhost:3000/docs](http://localhost:3000/docs) with a copy-paste
curl snippet that auto-substitutes your host and pasted key, plus a `test it`
button that runs the GET endpoints from your browser against your own key.
The reference is generated from `apps/web/lib/api-reference.ts` and a test
asserts every documented path resolves to a real route file, so the page
cannot drift out of sync with the code.

```bash
curl http://localhost:3000/v1/keys/me \
  -H "authorization: Bearer adh_..."
```


If a secret leaks, hit `Rotate` on the API keys page (or `POST
/api/keys/<id>/rotate`) to mint a new plaintext in place. Rotation keeps the
key id, name, created date, last-used time, and total call count so charts
and audit trails stay continuous, while the old secret stops working
immediately. Revoked keys cannot be rotated; create a fresh one instead.

**Rotate from a shell, no dashboard required.** Incident responders can
roll the calling key in place with `POST /v1/keys/me/rotate`. Possession of
the current secret is the only authority required, and the body must carry
`{"confirm": true}` so a stray curl cannot accidentally invalidate a
production credential. The response is the new plaintext, returned exactly
once, alongside the standard `X-RateLimit-*` headers. The rotation lands in
the dashboard audit log under `api_key.rotate.self` with the old and new
prefixes and the caller IP.

```sh
curl -X POST http://localhost:3000/v1/keys/me/rotate \
  -H "authorization: Bearer adh_OLD..." \
  -H "content-type: application/json" \
  -d '{"confirm": true}'
```

**Bulk export from the API.** Keys with the `read` scope can stream the
run log directly with `GET /v1/runs/export`, mirroring the History page
exports (CSV, JSON, NDJSON) with the same `q`, `kind`, `tag`, `from`, and
`to` filters. Wire it into cron, Sheets, or a BI pipeline without
screen-scraping. Filenames carry the applied filter suffix and the
`x-export-count` / `x-export-truncated` headers tell you exactly how many
rows came back.

```bash
curl -L "http://localhost:3000/v1/runs/export?format=csv&kind=predict" \
  -H "authorization: Bearer adh_..." \
  -o runs.csv
```

**Full CRUD over the API.** Keys with the `predict` scope can now create,
rename, retag, share, and delete individual runs without touching the
browser. This turns `/v1/runs` into a complete contract you can wire into
your own notebooks, ingestion jobs, or admin dashboards.

```bash
# create a run from an external job
curl -X POST http://localhost:3000/v1/runs \
  -H "authorization: Bearer adh_..." \
  -H "content-type: application/json" \
  -d '{"kind":"predict","title":"batch 42","payload":{"risk":0.31},"tags":["nightly"]}'

# rename + retag
curl -X PATCH http://localhost:3000/v1/runs/<id> \
  -H "authorization: Bearer adh_..." \
  -H "content-type: application/json" \
  -d '{"title":"q3 baseline","tags":["billed","q3"]}'

# mint (or revoke) a public share link
curl -X POST http://localhost:3000/v1/runs/<id>/share \
  -H "authorization: Bearer adh_..." \
  -H "content-type: application/json" \
  -d '{"enable":true}'

# delete
curl -X DELETE http://localhost:3000/v1/runs/<id> \
  -H "authorization: Bearer adh_..."
```


Keys can be issued with an optional time-to-live (7, 30, 90, or 365 days,
or `never`). Once a key passes its `expires_at`, every `/v1` endpoint
refuses it with `401`, exactly like a revoked key, and the dashboard tags it
with an `expired` badge plus a relative countdown (`in 6d`, `2d ago`, ...).
The `/v1/keys/me` introspection endpoint surfaces `expires_at` so you can
wire your own renewal alerting. Set the TTL on the create form, or pass
`ttl_days` to `POST /api/keys`:

```bash
curl -X POST http://localhost:3000/api/keys \
  -H "content-type: application/json" \
  -d '{"name":"ci-bot","scopes":["predict"],"ttl_days":30}'
```

Each key also supports an optional per-key daily quota that is independent
of the workspace plan. Set `Cap/day` on the API keys table (or `PATCH
/api/keys/<id>` with `{"daily_quota": N}`) and the key is hard-limited to
`N` calls per UTC day across `/v1/predict` and `/v1/batch`, even when the
plan still has headroom. Capped responses include standard rate-limit
headers so HTTP clients can back off without parsing JSON:

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Scope: api_key
Retry-After: 3600
```

Set `daily_quota` back to `null` to remove the cap:

```bash
curl -X PATCH http://localhost:3000/api/keys/KEY_ID \
  -H "content-type: application/json" \
  -d '{"daily_quota": 100}'
```

```bash
curl -X POST http://localhost:3000/v1/predict \
  -H "authorization: Bearer adh_YOUR_KEY" \
  -H "content-type: application/json" \
  -d '{
    "user_id": "u_123",
    "doses": [
      {"dose_id":"d1","scheduled_at":"2025-01-01T08:00:00Z","dose_class":"statin","dose_strength_mg":20}
    ]
  }'
```

Need to confirm a key works without burning predict quota? `GET /v1/keys/me`
is a read-only introspection endpoint that returns the key id, name, prefix,
scopes, created/last-used timestamps, and total call count. It requires the
`read` scope and never echoes the plaintext or its hash.

```bash
curl http://localhost:3000/v1/keys/me \
  -H "authorization: Bearer adh_YOUR_KEY"
```

Need a programmatic quota meter for your own dashboard, CI guardrail, or
billing alert? `GET /v1/usage` returns the same shape the in-app `/usage`
page renders: today's quota, used and remaining counts, a 30 day window of
daily totals, and a per-key 30 day breakdown. It also sends standard
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`
headers so any HTTP client library can surface remaining capacity without
parsing JSON. It requires the `read` scope and does not consume quota.

```bash
curl -i http://localhost:3000/v1/usage \
  -H "authorization: Bearer adh_YOUR_KEY"
```

Click `usage` on any row in the API keys table to open the per-key dashboard
at `/api-keys/<id>`. It shows total calls, last-24h and last-7d counts, a
14-day call-volume chart, breakdowns by endpoint and HTTP status, and the
last 100 requests with timestamp, method, path, status, and latency. The
page auto-refreshes every 5 seconds, so a customer running a test can watch
their first call land in real time. Events are appended to
`apps/web/.data/api-key-usage.jsonl` and capped at 5 MB / 5,000 rows by an
automatic compaction pass, so the file stays bounded in dev. `GET
/api/keys/<id>/usage?limit=N` returns the same payload as JSON.

### Run history

Every scored prediction, cohort sweep, and forecast call made through the web
app is automatically saved to a per-instance run log under `apps/web/.data/runs.jsonl`
(override path with `ADHERENCE_DATA_DIR`). Open
[http://localhost:3000/history](http://localhost:3000/history) to search,
filter by kind, rename, tag, pin important runs to the top, copy a shareable link (`/history/<id>`), delete,
or export the full log as CSV, JSON, or NDJSON. Select multiple rows with the
per-row checkboxes (or the page-level select-all) and the floating action bar
lets you pin, unpin, or delete the entire selection in one request. The History page exports
honor the active search, kind, and date-range filters, so you can pull just
"failed predict runs in the last 7 days" without post-processing. The detail
page is a plain server route so links are shareable in incognito.

**Re-run a past prediction.** Open any predict (or demo) run at
`/history/<id>` and click **Re-run** in the header. The button deep-links
to `/predict?from=<id>`, which fetches `/api/runs/<id>/clone` and prefills
the user id, top-k, and the entire dose schedule so you can tweak one
field and resubmit without retyping. Non-replayable kinds (explain,
forecast) hide the button instead of showing a dead control.

```bash
# see the inputs that would be replayed
curl -s http://localhost:3000/api/runs/<run-id>/clone | jq
```

**Saved views.** Once your filter bar is dialed in (search, kind, date range,
tags, pinned-only) click *save view*, give it a name, and it appears as a
one-click chip above the filters. Saved views are per-user (anonymous sessions
share an `_anon` bucket) and persist in `apps/web/.data/saved-searches.jsonl`,
so power users can build a working set of views like *Failed predicts this
week* or *VIP cohort* and flip between them without re-typing.

```bash
# create a saved view via the API
curl -s -X POST http://localhost:3000/api/saved-searches \
  -H 'content-type: application/json' \
  -d '{"name":"Pinned predicts","filters":{"kind":"predict","pinned_only":true,"q":"","from":"","to":"","tags":[]}}'

# list, rename, delete
curl -s http://localhost:3000/api/saved-searches
curl -s -X PATCH http://localhost:3000/api/saved-searches/<id> \
  -H 'content-type: application/json' -d '{"name":"Top urgent cases"}'
curl -s -X DELETE http://localhost:3000/api/saved-searches/<id>
```

API surface:

- `GET /api/runs?q=&kind=&from=&to=&tag=&pinned=1&limit=&offset=` list with search, date range, multi-tag (repeat `tag=` for AND match), pinned-only filter, pagination
- `POST /api/runs` append a record (validated with zod)
- `GET /api/runs/:id` fetch one
- `PATCH /api/runs/:id` rename, retag, or pin (`{ title?, tags?, pinned? }`)
- `DELETE /api/runs/:id` remove
- `POST /api/runs/bulk` body `{ action: "delete"|"pin"|"unpin", ids: string[] }` bulk operate on up to 500 runs in a single write
- `GET /api/runs/tags?kind=` list every tag in use with its run count, optionally narrowed by kind, for the history filter chips
- `GET /api/runs/export?format=csv|json|ndjson&q=&kind=&from=&to=&tag=&user_id=` filtered download (repeat `tag=` to AND multiple)
- `GET /api/runs/:id/download` per-run JSON download (attachment with safe filename)
- `GET /api/runs/:id/pdf` per-run printable PDF report (single page, includes title, kind, timestamp, risk score if present, and a truncated payload dump)
- `GET /api/runs/:id/share` current public-share status for a run
- `POST /api/runs/:id/share` body `{ enabled: boolean }` mint or revoke a public share link
- `GET /api/runs/:id/notes` list every note attached to a run, oldest first
- `POST /api/runs/:id/notes` body `{ body: string }` append a note (1-2000 chars, attributed to the signed-in user when present)
- `DELETE /api/runs/:id/notes/:noteId` soft-delete a note; only the original author may delete

#### Notes on a run

Open any run detail page at `/history/<id>` and scroll to the `Notes` card to
add timestamped annotations. Useful for clinical follow-ups ("called patient,
rescheduled dose"), QA tags ("flagged for retraining"), or shift handoffs.
Notes are scoped to the run, attributed to the signed-in user's email, and
can only be deleted by their author. Try it with curl:

```bash
curl -s -X POST http://localhost:3000/api/runs/<run-id>/notes \
  -H 'Content-Type: application/json' \
  -d '{"body":"Called patient, dose rescheduled to 9pm."}'
```

Share a single run publicly from its detail page with the `Create public link`
button. That mints a 22-character token and exposes the run read-only at
`/share/<token>`. Anyone with the link can view it without signing in, the
owner can revoke it at any time, and the public page is `noindex` so it stays
out of search. Public share links unfurl in Slack, iMessage, Twitter, and
LinkedIn with a generated 1200x630 OG card (`/share/<token>/opengraph-image`)
showing the run title, kind, top miss probability, risk tier, and tags. Use the `Download JSON` button to grab the full payload as a
timestamped file, or `Download PDF` for a one-page printable report (handy
for sharing with a clinician or attaching to a chart note). The PDF renderer
is zero-dependency, so no headless browser is needed in production.

Pinned runs sort first across every view and survive search, kind, and tag
filters. Click the pin icon on any row in the History page to keep a run at
the top across sessions, or toggle the `pinned` chip in the filter bar to
focus on just the pinned set. Pin state is stored on the run record itself
(`pinned`, `pinned_at`), so it is included in JSON/NDJSON exports and the
`/api/runs` listing without an extra round trip.

```bash
# Pin a run
curl -X PATCH http://localhost:3000/api/runs/<id> \
  -H 'content-type: application/json' \
  -d '{"pinned": true}'

# List only pinned runs
curl 'http://localhost:3000/api/runs?pinned=1&limit=10'
```

Try it:

```bash
# printable PDF report for a single run (replace <id> with a real run id)
curl -sS -o report.pdf 'http://localhost:3000/api/runs/<id>/pdf'

# every cohort run with the "prod" tag from June, as NDJSON
curl -sS 'http://localhost:3000/api/runs/export?format=ndjson&kind=cohort&tag=prod&from=2025-06-01&to=2025-06-30' \
  -o cohort-prod-june.ndjson

# list every tag in use across saved runs with its count
curl -sS 'http://localhost:3000/api/runs/tags'

# runs that carry BOTH the "prod" and "v2" tags (AND match)
curl -sS 'http://localhost:3000/api/runs?tag=prod&tag=v2'
```

The History page renders one clickable chip per tag with its live count, so
you can stack filters (`#prod` + `#v2`) without typing in the search box.
Selecting chips updates the list, pagination, and every CSV/JSON/NDJSON
export link in the toolbar in the same click.

Unit test: `pnpm --filter @adherence/web test`.

### Onboarding

First-run users land at
[http://localhost:3000/onboarding](http://localhost:3000/onboarding):
a three-step checklist (explore the demo, issue an API key, save a run)
with per-step completion tracking and a one-click sample-workspace
seeder. The seeder is idempotent and creates three saved runs across the
demo personas, one demo API key (auto-revoked so it cannot hit
production), and one inactive webhook endpoint at
`https://example.com/adherence/webhook`. State lives in
`apps/web/.data/onboarding.json`. Unit-tested in
`tests/onboarding-store.test.ts`.

```bash
curl http://localhost:3000/api/onboarding
curl -X POST http://localhost:3000/api/onboarding/seed
curl -X PATCH http://localhost:3000/api/onboarding \
  -H 'content-type: application/json' \
  -d '{"step":"explore_demo","done":true}'
```

### Workspaces and teammate invites

Every signed-in account gets a personal workspace on first visit. Open
[/workspace](http://localhost:3000/workspace) to see members, send email
invites with a role (owner, editor, or viewer), copy the shareable
`/invite/<token>` link, revoke pending invites, or remove members. Invites
expire after 7 days, are bound to the email they were sent to so a leaked
link cannot be redeemed by a different account, and the workspace refuses
to remove the last owner. State lives in `apps/web/.data/workspaces.json`
and is unit-tested in `tests/workspaces-store.test.ts` (4 cases covering
auto-creation, role-bound accept, duplicate-invite rejection, and the
last-owner guard).

```bash
# List the signed-in user's workspaces (cookie-auth, so use the browser or
# pipe `Cookie: adh_session=...` from devtools).
curl http://localhost:3000/api/workspaces

# Invite a teammate (returns a one-time accept_url to share).
curl -X POST http://localhost:3000/api/workspaces/<ws_id>/invites \
  -H 'content-type: application/json' \
  -d '{"email":"teammate@company.com","role":"editor"}'
```


### Schedules (recurring predictions)

Save a prediction payload once and have it re-run on a daily or weekly
cadence at a fixed UTC hour. Each fire appends a new record to history
tagged `scheduled` and fans the `run.created` event out to registered
webhooks. Manage schedules at
[/schedules](http://localhost:3000/schedules): create, pause/resume, fire
now, delete, and inspect the last 25 deliveries with latency and error
detail. State lives in `apps/web/.data/schedules.json`.

A cron tick endpoint at `/api/schedules/tick` fires every schedule whose
`next_run_at` is in the past. Wire it into Vercel Cron, GitHub Actions, or
plain `crond`. Set `ADHERENCE_CRON_SECRET` to require an `x-cron-secret`
header. The pure scheduling math is covered by
`tests/schedules-store.test.ts` (6 cases across daily and weekly rollover).

```bash
# Create a daily schedule that fires at 14:00 UTC.
curl -X POST http://localhost:3000/api/schedules \
  -H 'content-type: application/json' \
  -d '{
    "name": "Daily risk sweep",
    "cadence": "daily",
    "hour_utc": 14,
    "payload": {
      "user_id": "u_demo",
      "doses": [{
        "dose_id": "d1",
        "scheduled_at": "2025-06-15T20:00:00Z",
        "dose_class": "statin",
        "dose_strength_mg": 20
      }]
    }
  }'

# Manually tick the cron (use GET so it is curl + Vercel Cron friendly).
curl http://localhost:3000/api/schedules/tick
```

## Try it

With the API on `:8000` and the web app on `:3000`, open
[http://localhost:3000/demo](http://localhost:3000/demo) for the one-click
demo.

Upgrade plan and inspect quota:

```bash
# Current plan + quota
curl http://localhost:3000/api/plan

# Switch to Pro (applies immediately, recorded in plan history)
curl -X POST http://localhost:3000/api/plan/checkout \
  -H 'content-type: application/json' \
  -d '{"plan":"pro"}'

# Confirm the new daily quota on the usage endpoint
curl http://localhost:3000/api/usage | jq '{quota, used_today, remaining_today}'
```

Then visit [/pricing](http://localhost:3000/pricing) and
[/billing](http://localhost:3000/billing) in the UI.

The original demo flow:

Three preloaded patient personas (stable hypertension, slipping
diabetes plus SSRI, newly prescribed antibiotic course) ship with 14 days of
synthetic dosing history. Picking a persona POSTs the full schedule and
history to `POST /v1/predict` and renders per-dose miss probability, risk
tier, a recharts risk distribution, SHAP-derived reason codes, and observed
call latency against the calibrated ensemble. The landing page at
[http://localhost:3000](http://localhost:3000) still offers an inline
three-card preview, and
[http://localhost:3000/predict](http://localhost:3000/predict) lets you hand
build a dose schedule, see a recharts miss-probability bar chart with risk
thresholds, the round-trip latency in milliseconds, and keeps your last eight
runs on-device for one-click restore. Any result can be published to a
public shareable URL at `/r/<id>` via the new `Share` button, which POSTs
the full request and response to `POST /api/shares` and renders the rendered
result (chart, dose table, reason codes, OpenGraph preview) for anyone with
the link, no account required. Shares persist to `.data/shares.json` next to
the Next.js app and are read back by `GET /api/shares/<id>`. You can manage
them at [`/shares`](http://localhost:3000/shares): the page lists every link
you created, searches by id or title, shows the top miss probability and
model version on each row, lets you copy or open the public URL, and revokes
links with a two-step confirm. Revoking is owner-scoped: `DELETE
/api/shares/<id>` returns 403 when the session user does not own the share.
Try it:

```bash
curl -s 'http://localhost:3000/api/shares?scope=all&limit=5'
# -> {"items":[{"id":"...","title":"...","top_risk":0.78,...}],"total":...}
curl -s -X DELETE http://localhost:3000/api/shares/<ID>
# -> {"deleted":true,"id":"<ID>"}
```

Every `/r/<id>` link now serves a real 1200x630 OpenGraph PNG at
`/r/<id>/opengraph-image`, generated on the fly with `next/og`. It shows the
run title, kind, top miss probability, risk tier, and tags, so links unfurl
cleanly in Slack, iMessage, X, and LinkedIn. The page also emits matching
`twitter:card` and `og:image` meta tags. Try it locally:

```bash
curl -s -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{"kind":"predict","title":"Persona Alex // morning miss risk","summary":"3 doses scored","payload":{"response":{"predictions":[{"miss_probability":0.78,"risk_tier":"high"}]}},"tags":["demo"]}'
# -> {"id":"<ID>"}
curl -s -o preview.png http://localhost:3000/r/<ID>/opengraph-image
```

Quick share round-trip:

```bash
curl -s -X POST http://localhost:3000/api/shares \
  -H 'content-type: application/json' \
  -d '{
    "user_id":"demo-user-001",
    "top_k":3,
    "rows":[{"dose_id":"d1","scheduled_at":"2026-06-01T12:00:00Z","dose_class":"cardio","dose_strength_mg":10}],
    "result":{"user_id":"demo-user-001","model_version":"v0","predictions":[{"dose_id":"d1","scheduled_at":"2026-06-01T12:00:00Z","miss_probability":0.42,"risk_tier":"medium","reasons":[]}]}
  }'
# -> {"id":"...","url":"/r/..."}  open http://localhost:3000/r/<id>
```

Recurring predictions (schedules):

```bash
# 1. create a daily schedule that fires at 08:00 UTC against patient u_123
curl -s -X POST http://localhost:3000/api/schedules \
  -H 'content-type: application/json' \
  -d '{
    "name":"Morning statin check",
    "cadence":"daily",
    "hour_utc":8,
    "payload":{
      "user_id":"u_123",
      "doses":[{"dose_id":"d1","scheduled_at":"2026-06-01T08:00:00Z","dose_class":"statin","dose_strength_mg":20}]
    }
  }'

# 2. fire every due schedule now (also wired for external cron;
#    set ADHERENCE_CRON_SECRET in prod and pass it as x-cron-secret)
curl -s -X POST http://localhost:3000/api/schedules/tick

# 3. list schedules with next_run_at, success/failure counters, recent runs
curl -s http://localhost:3000/api/schedules | jq
```

Each fire calls `/v1/predict` upstream, appends the result to history with a
`scheduled` tag (browse them at `/history?tag=scheduled` or in the schedule's
drawer), and fans out as a `run.created` webhook event. Pause, resume, or
delete schedules in the UI at
[http://localhost:3000/schedules](http://localhost:3000/schedules).
[http://localhost:3000/compare](http://localhost:3000/compare) scores all
three personas in parallel and ranks who needs an intervention first with a
composite triage score and a cohort-wide top-reasons chart aggregated from
the real SHAP attributions.

```bash
curl -s http://localhost:8000/v1/predict \
  -H 'content-type: application/json' \
  -d '{
    "user_id": "demo-cardio-001",
    "doses": [
      {"dose_id": "morning-bb",  "scheduled_at": "2026-06-01T08:00:00Z", "dose_class": "cardio", "dose_strength_mg": 25},
      {"dose_id": "evening-statin", "scheduled_at": "2026-06-01T20:00:00Z", "dose_class": "cardio", "dose_strength_mg": 40}
    ],
    "top_k_reasons": 3
  }' | jq .
```

Project a user's next week of adherence with a confidence interval:

```bash
curl -s 'http://localhost:8000/v1/forecast/user?model_name=default' \
  -H 'content-type: application/json' \
  -d '{
    "user_id": "demo-okafor-daniel",
    "horizon_days": 7,
    "history": [
      {"user_id":"demo-okafor-daniel","dose_id":"metformin-am-d1","scheduled_at":"2026-05-23T15:00:00Z","taken_at":"2026-05-23T15:08:00Z","status":"taken","dose_class":"endocrine","dose_strength_mg":500}
    ]
  }' | jq .
```

## Batch scoring

Upload a CSV of scheduled doses at
[http://localhost:3000/batch](http://localhost:3000/batch) to score up to 500
doses across 50 users in one request. Drop the file, preview the parsed rows,
run, then download the predictions as CSV or JSON. The page rejects oversize
uploads, flags missing columns, and surfaces row-level validation errors
before calling the model. Required columns: `user_id, dose_id, scheduled_at,
dose_class, dose_strength_mg`.

The same endpoint is callable directly. Pipe a CSV file in and add
`?format=csv` to get a CSV download back:

```bash
curl -sS -X POST 'http://localhost:3000/api/batch?format=csv' \
  -H 'content-type: text/csv' \
  --data-binary @doses.csv
```

Or post JSON for a structured response with per-user counts and a summary:

```bash
curl -sS -X POST http://localhost:3000/api/batch \
  -H 'content-type: application/json' \
  -d '{"csv":"user_id,dose_id,scheduled_at,dose_class,dose_strength_mg\nu1,d1,2025-06-01T08:00:00Z,cardio,10\n"}'
```

### Batch over the public API

The browser flow above is convenient, but production integrations should
use the key-authenticated `POST /v1/batch` endpoint. It accepts the same
CSV schema, returns CSV or JSON, and meters every row against the daily
plan quota (the request is rejected with `429` before any scoring runs if
the batch would exceed the remaining quota). Each successful batch shows
up in `/history` under the API key used to call it. Limits: 1000 rows,
100 users, 512 KB per request. Requires the `predict` scope.

```bash
curl -sS -X POST 'http://localhost:3000/v1/batch?format=csv' \
  -H 'authorization: Bearer adh_YOUR_KEY' \
  -H 'content-type: text/csv' \
  --data-binary @doses.csv
```

Or JSON in, JSON out:

```bash
curl -sS -X POST http://localhost:3000/v1/batch \
  -H 'authorization: Bearer adh_YOUR_KEY' \
  -H 'content-type: application/json' \
  -d '{"csv":"user_id,dose_id,scheduled_at,dose_class,dose_strength_mg\nu1,d1,2025-06-01T08:00:00Z,cardio,10\n","top_k":3}'
```

Response headers include `x-quota-limit`, `x-quota-used`,
`x-quota-remaining`, `x-batch-rows`, `x-batch-users`, and `x-latency-ms`
so clients can back off cleanly. `GET /v1/batch` returns the full schema
and limits as JSON.

## Features

- Recurring schedules (`/schedules`): create a daily or weekly cadence over
  any saved prediction payload. The cron tick (`POST /api/schedules/tick`)
  fires every due job through `/v1/predict`, streams results into history
  with a `scheduled` tag, and emits a `run.created` webhook. Protected with
  `ADHERENCE_CRON_SECRET` when set; recent runs, latency, and failure
  reasons surface inline per schedule.

- Landing demo (`/`) with three click-to-run patient scenarios, live miss
  probability, risk tier bars, latency, and SHAP reason codes.
- Forecast page (`/forecast`) backed by `POST /v1/forecast/user`: pick a
  persona and horizon (3, 7, or 14 days), see the projected adherence rate
  with a 90 percent bootstrap CI, a daily projection chart, and a per-day
  breakdown of dose count, high-risk doses, and miss probability.
- Cohort browser (`/cohort`) backed by `POST /v1/cohort/risk` with CSV export
  via `/v1/cohort/risk/export`.
- Predict endpoint with batch variant (`POST /v1/predict`, `POST /v1/predict/batch`).
- SHAP-style explainer at predict time and aggregated under
  `/v1/explain/global` and `/v1/explain/sample`, surfaced in the `/explain`
  page as a waterfall chart.
- Intervention queue (`/v1/interventions`, `/v1/interventions/from-predictions`)
  with risk-tier policies, quiet-hours, notification budgets, mutes, ack, and
  expiry sweeps.
- Append-only audit log with stats, listing, and CSV export
  (`/v1/audit/list`, `/v1/audit/stats`, `/v1/audit/export.csv`).
- Calibration and feature-importance pages backed by PNG plots
  (`/v1/plots/calibration.png`, `/v1/plots/importance.png`) and
  `/v1/metrics/calibration-drift`.
- Drift check endpoint (`/v1/drift/check`) with PSI threshold + optional
  webhook.
- Outbound webhook subscriptions with replay (`/v1/webhooks/outbound/*`) and
  inbound med-tracker callback (`/v1/webhooks/medtracker/event`).
- A/B experiments scaffolding (`/v1/experiments/*`).
- Async training jobs via Redis/RQ worker (`POST /v1/train/async`).
- Prometheus metrics (`/metrics`) and OpenTelemetry tracing.

## Stack

- **Web**: Next.js 15 (App Router, React 19), Tailwind v4, Recharts, SWR,
  Phosphor icons. Server-side proxy to the API so API keys never reach the
  browser.
- **API**: FastAPI + Uvicorn, Pydantic v2, SQLAlchemy 2 + Alembic, JWT
  (PyJWT) + API-key auth, Prometheus + OTLP.
- **ML**: scikit-learn, XGBoost, LightGBM, SHAP, isotonic calibration, MLflow
  for tracking, joblib for on-disk model artifacts.
- **Infra**: Postgres 16, Redis 7 (RQ queues), MLflow server, Docker Compose
  for dev. Terraform + Helm scaffolding under `infra/`.
- **CLI**: Typer (`adherence-ml`) for generate-data, train, backtest, predict,
  serve.

## Architecture

```
 med-tracker events ──▶ packages/data ──▶ packages/features ──▶ training frame
                                                                   │
                                                                   ▼
                                                  services/trainer (XGB+LGBM
                                                  ensemble + isotonic calib)
                                                                   │
                                                                   ▼
                                                  models/registry (joblib +
                                                  *_index.json) + MLflow
                                                                   │
            ┌──────────────────────────────────────────────────────┘
            ▼
  services/api  ── /v1/predict, /v1/cohort, /v1/explain, /v1/metrics ──┐
            │                                                          │
            ├──▶ Postgres (audit, policies, mutes, deliveries,         │
            │             experiments, subscriptions)                  │
            ├──▶ Redis + RQ ──▶ services/inference_worker              │
            │                                                          │
            └──────────────────────────────────────────────────────▶ apps/web
                                                              (Next.js 15)
```

Features are derived strictly from events with `event_time < scheduled_at` to
avoid leakage. The trainer registers each model under a name (e.g. `default`)
with a versioned joblib file plus an `<name>_index.json` pointer; the API
loads the active version on first request and supports rollback via
`/v1/admin/models/{name}/rollback`.

## Quick start

Prereqs: Python 3.11 or 3.12, [uv](https://github.com/astral-sh/uv), Node 20+,
pnpm 9, Docker (optional, for Postgres/Redis/MLflow).

```bash
git clone <repo> adherence-ml
cd adherence-ml

# Python install (creates .venv, installs all packages + services)
uv sync --extra dev

# Env
cp .env.example .env

# Option A: full stack via Docker (postgres + redis + mlflow + api + worker + trainer)
./scripts/dev_up.sh

# Option B: local Python only
#   Train a baseline on synthetic data
./scripts/train_baseline.sh
#   Run the API
uv run adherence-ml serve   # or: uv run uvicorn adherence_api.app:create_app --factory --port 7421
```

Web app (separate terminal):

```bash
cd apps/web
cp .env.example .env.local       # set ADHERENCE_API_BASE + ADHERENCE_API_KEY
pnpm install
pnpm dev                          # http://localhost:3000
```

End-to-end smoke (trains a `demo` model and runs a 3-dose predict):

```bash
./scripts/demo_predict.sh
```

## Configuration

API (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADHERENCE_ENV` | `dev` | Environment tag |
| `ADHERENCE_LOG_LEVEL` | `INFO` | Log level |
| `ADHERENCE_API_HOST` | `0.0.0.0` | Bind host |
| `ADHERENCE_API_PORT` | `7421` | Bind port |
| `ADHERENCE_JWT_SECRET` | (required) | HMAC secret for `/v1/admin/token` |
| `ADHERENCE_JWT_ALG` | `HS256` | JWT algorithm |
| `ADHERENCE_JWT_TTL_SECONDS` | `3600` | JWT lifetime |
| `ADHERENCE_API_KEYS` | dev placeholders | `role:key` pairs, comma-separated |
| `ADHERENCE_DB_URL` | local Postgres DSN | SQLAlchemy URL (psycopg) |
| `ADHERENCE_REDIS_URL` | `redis://localhost:6379/0` | Redis for RQ + rate limit |
| `ADHERENCE_MLFLOW_TRACKING_URI` | `http://localhost:5000` | MLflow server |
| `ADHERENCE_MODEL_REGISTRY` | `./models/registry` | Joblib registry path |
| `ADHERENCE_DRIFT_WEBHOOK_URL` | empty | Drift alert webhook |
| `ADHERENCE_DRIFT_PSI_THRESHOLD` | `0.2` | PSI alert threshold |
| `MEDTRACKER_BASE_URL` | empty | Upstream event source |
| `MEDTRACKER_API_KEY` | empty | Upstream auth |
| `OTEL_SERVICE_NAME` | `adherence-ml` | OTel service name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | OTLP collector |
| `ADHERENCE_SENTRY_DSN` | empty | Sentry DSN; empty disables shipping |
| `ADHERENCE_SENTRY_ENVIRONMENT` | falls back to `ADHERENCE_ENV` | Sentry environment tag |
| `ADHERENCE_SENTRY_TRACES_SAMPLE_RATE` | `0.0` | Performance trace sample rate (0.0 to 1.0) |
| `ADHERENCE_SENTRY_PROFILES_SAMPLE_RATE` | `0.0` | Profiling sample rate (0.0 to 1.0) |

Web (`apps/web/.env.local`):

| Variable | Purpose |
| --- | --- |
| `ADHERENCE_API_BASE` | Backend FastAPI base URL (server-side only) |
| `ADHERENCE_API_KEY` | Admin-role API key for protected routes |

## Scripts

CLI (`uv run adherence-ml ...`):

| Command | What it does |
| --- | --- |
| `version` | Print package version |
| `generate-data` | Write synthetic events parquet to `data/generated/` |
| `train` | Train ensemble (synthetic or from `--events`), register under `--name` |
| `backtest` | Time-series backtest with `--test-days` holdout |
| `predict` | Score a JSON schedule for a user_id, optional `--history` |
| `serve` | Run the FastAPI app via uvicorn |
| `list-models` | List registered model versions |

Shell helpers in `scripts/`:

- `dev_up.sh` — `docker compose -f infra/docker/docker-compose.dev.yml up --build`
- `train_baseline.sh` — generate-data + train `default` + list-models
- `demo_predict.sh` — train `demo` then call `predict` on 3 sample doses
- `export_openapi.py` — dump the OpenAPI schema

Web (`apps/web`, pnpm):

| Script | What it does |
| --- | --- |
| `pnpm dev` | Next dev server on :3000 |
| `pnpm build` | Production build |
| `pnpm start` | Production server on :3000 |
| `pnpm lint` | `next lint` |
| `pnpm typecheck` | `tsc --noEmit` |

## API

All routes are under `/v1` unless noted. Auth is API key (`x-api-key`) or JWT
(`Authorization: Bearer ...`); roles are `admin`, `service`, `viewer`.

Health & ops

- `GET /healthz`, `GET /livez`
- `GET /metrics` (Prometheus text)

Predict

- `POST /v1/predict`
- `POST /v1/predict/batch`

Cohort

- `POST /v1/cohort/risk`
- `POST /v1/cohort/risk/export` (CSV)

Explain

- `GET /v1/explain/global`
- `GET /v1/explain/sample`

Forecast

- `POST /v1/forecast/user`

Train (admin)

- `POST /v1/train`
- `POST /v1/train/async`

Drift

- `POST /v1/drift/check`

Plots

- `GET /v1/plots/calibration.png`
- `GET /v1/plots/importance.png`

Metrics (online quality)

- `GET /v1/metrics/online`
- `GET /v1/metrics/online/report`
- `GET /v1/metrics/calibration-drift`

Audit (admin)

- `GET /v1/audit/list`
- `GET /v1/audit/stats` (tenant-scoped; admin may pass `?tenant=*`)
- `GET /v1/audit/shadow` (tenant-scoped; admin may pass `?tenant=*`)
- `GET /v1/audit/verify` (tenant-scoped break list; admin may pass `?tenant=*`)
- `GET /v1/audit/export.csv`

Every `/v1/audit/*` reader now defaults the result set to the calling
key's tenant id. Admins may pass `?tenant=<id>` for another tenant or
`?tenant=*` for a fleet-wide compliance read. Try it:

```bash
curl -sH "x-api-key: $ACME_ADMIN_KEY" \
  http://localhost:8000/v1/audit/stats?window_hours=24
```

Interventions

- `POST /v1/interventions`
- `POST /v1/interventions/from-predictions`
- `POST /v1/interventions/{delivery_id}/ack`
- `GET  /v1/interventions/deliveries/{user_id}`
- `GET  /v1/interventions/stats`
- `POST /v1/interventions/expire`

Policies

- `GET /v1/policies/risk`, `PUT /v1/policies/risk`, `DELETE /v1/policies/risk`
- `PUT/GET/DELETE /v1/policies/quiet-hours/{user_id}`
- `PUT/GET/DELETE /v1/policies/notification-budget/{user_id}`

Mutes

- `PUT/GET/DELETE /v1/users/{user_id}/mute`
- `GET /v1/admin/mutes`

Experiments

- `POST /v1/experiments`, `GET /v1/experiments`, `GET /v1/experiments/{key}`
- `PATCH /v1/experiments/{key}/state`
- `POST /v1/experiments/{key}/assign`
- `POST /v1/experiments/{key}/events`
- `GET /v1/experiments/{key}/results`

Webhooks

- Inbound: `POST /v1/webhooks/medtracker/event`, `GET /v1/webhooks/medtracker/recent`
- Outbound: `PUT/GET /v1/webhooks/outbound/subscriptions`,
  `DELETE /v1/webhooks/outbound/subscriptions/{name}`,
  `GET /v1/webhooks/outbound/deliveries`,
  `POST /v1/webhooks/outbound/deliveries/{delivery_id}/replay`,
  `POST /v1/webhooks/outbound/test-send`

Admin

- `POST /v1/admin/token`
- `GET  /v1/admin/models`
- `POST /v1/admin/models/{name}/rollback`
- `POST /v1/admin/api-keys`, `GET /v1/admin/api-keys`,
  `POST /v1/admin/api-keys/{name}/revoke`
- `POST /v1/admin/audit/retention`

The full OpenAPI is available at `/docs` (Swagger) and `/openapi.json`, or
dump it with `uv run python scripts/export_openapi.py`.

## Model

Per-dose binary classifier (`label = dose missed`). The ensemble averages
calibrated XGBoost and LightGBM probabilities (`packages/models/adherence_models/ensemble.py`),
fit with isotonic calibration on a held-out slice
(`packages/models/adherence_models/calibration.py`). Training and evaluation
metrics include ROC AUC, PR AUC, Brier score, log loss, and reliability bins
(`packages/eval/adherence_eval`).

Features (`packages/features/adherence_features/engineering.py`,
`FEATURE_COLUMNS`):

```
hour_sin, hour_cos, dow_sin, dow_cos, is_weekend,
time_bucket_idx, dose_class_idx, dose_strength_mg,
streak_taken, streak_missed,
recent_miss_rate_7d, recent_miss_rate_24h, recent_late_rate_7d,
doses_today_so_far, doses_yesterday,
minutes_since_last_dose, minutes_since_last_taken,
sleep_window_proxy, n_classes_user, user_n_doses_history
```

All features are computed from events strictly before `scheduled_at` to avoid
leakage.

Artifacts live in `models/registry/` as
`<name>__<UTC timestamp>.joblib` with a sibling `<name>_index.json` pointing at
the active version. The registry is loaded by `packages/models/adherence_models/registry.py`.
Rollback via `POST /v1/admin/models/{name}/rollback`.

Retrain:

```bash
# synthetic
uv run adherence-ml train --synthetic --users 5000 --days 60 --name default

# from a parquet of real events
uv run adherence-ml train --no-synthetic --events data/events.parquet --name default

# time-series backtest
uv run adherence-ml backtest --synthetic --users 2000 --days 45 --test-days 7
```

## Project structure

```
adherence-ml/
├── apps/
│   └── web/                    # Next.js 15 dashboard (cohort, predict,
│                               # explain, interventions, audit, dashboard)
├── packages/
│   ├── common/                 # settings, logging, telemetry, constants
│   ├── data/                   # synthetic generator, loaders, medtracker
│   ├── features/               # engineering.py (FEATURE_COLUMNS), drift.py
│   ├── models/                 # ensemble, calibration, registry, promotion
│   ├── eval/                   # metrics + reliability plots
│   └── explain/                # SHAP wrappers
├── services/
│   ├── api/                    # FastAPI app + routes/
│   ├── trainer/                # training pipeline (run_training, run_backtest)
│   ├── inference_worker/       # predict_doses, RQ worker
│   └── cli/                    # adherence-ml Typer CLI
├── clients/
│   ├── python/                 # generated Python client
│   └── typescript/             # generated TS client
├── infra/
│   ├── docker/                 # Dockerfile, Dockerfile.{trainer,worker},
│   │                           # docker-compose.dev.yml
│   ├── helm/adherence-ml/
│   └── terraform/
├── scripts/                    # dev_up.sh, train_baseline.sh,
│                               # demo_predict.sh, export_openapi.py
├── models/registry/            # joblib artifacts + *_index.json
├── data/samples/               # sample events
├── mlruns_sample/              # sample MLflow run
├── tests/                      # unit, property (hypothesis), integration
├── docs/                       # screenshots, diagrams
├── pyproject.toml              # uv-managed; defines adherence-ml entrypoint
└── uv.lock
```

## Operations

Deployment and on-call notes for running adherence-ml in production.

**Deploy.** Build the API image and ship via `infra/helm/adherence-ml`. The chart provisions API + worker + trainer deployments, a PodDisruptionBudget, optional HPA, ingress, and projects environment from a ConfigMap plus a Secret. Override the image tag and secrets per environment with `--values`.

**Scale.** API replicas default to 2 (`replicaCount.api`). Enable horizontal autoscaling with `autoscaling.enabled=true`; the api HPA scales on CPU (target 70 percent) and memory (target 80 percent) so a slow leak triggers scale-out instead of OOMKills (set `autoscaling.targetMemoryUtilizationPercentage=0` to opt out). The HPA carries a `behavior` block that biases scale-up aggressive (no stabilization, up to 100 percent or 4 pods per 30s) and scale-down conservative (5 minute stabilization window, max 1 pod per minute) so the fleet does not flap during diurnal load. Workers scale independently with `replicaCount.worker`; flip `autoscaling.worker.enabled=true` to bring up a CPU-targeted worker HPA (min 1, max 8, target 75 percent, 10 minute scale-down stabilization so transient queue drains do not yank workers mid-job). The worker HPA stays CPU-only by design until a Redis queue-depth metric adapter ships; size `replicaCount.worker` for peak queue depth and let the HPA absorb the rest. Chart rendering is pinned by `tests/unit/test_helm_autoscaling.py`.

**Backup.** Postgres holds the audit log, intervention queue, policies, mutes, deliveries, experiments, and webhook subscriptions. Take logical backups with `pg_dump` against `ADHERENCE_DB_URL` on a schedule and verify restores quarterly. Model artifacts live in `ADHERENCE_MODEL_REGISTRY` (joblib + `*_index.json` pointer); snapshot the registry volume after every training run that promotes a new active version.

**Error tracking (Sentry).** Set `ADHERENCE_SENTRY_DSN` to ship unhandled errors and traces from the API and inference worker. Sample rates are tunable via `ADHERENCE_SENTRY_TRACES_SAMPLE_RATE` and `ADHERENCE_SENTRY_PROFILES_SAMPLE_RATE` (both default 0.0). The integration covers FastAPI, Starlette, SQLAlchemy, and RQ, with a `before_send` hook that scrubs `Authorization`, `X-API-Key`, and `Cookie` headers plus any `api_key` or `token` query string before events leave the process. `send_default_pii` is forced off. In Helm, populate `secrets.sentryDsn` and tune `env.ADHERENCE_SENTRY_*` per environment. Leaving the DSN empty keeps Sentry fully disabled.

**Network policy.** The Helm chart ships default-deny `NetworkPolicy` objects for the `api`, `worker`, and `trainer` deployments, gated behind `networkPolicy.enabled` (off by default for backward compatibility with clusters whose CNI does not enforce NetworkPolicy or whose dependency pod labels differ). When enabled, ingress to the api is restricted to pods matching `networkPolicy.api.fromLabels` (defaults to `ingress-nginx`), any namespaces in `networkPolicy.api.fromNamespaceLabels`, optional Prometheus scrape from `networkPolicy.prometheusNamespaceLabels`, and same-chart sidecars when `networkPolicy.api.allowSameChart=true`. Workers accept ingress only from the api component; trainers accept none. All three pods may egress to kube-dns plus the in-cluster Postgres / Redis / MLflow selectors under `networkPolicy.egress.*` and any SaaS CIDRs listed in `networkPolicy.egress.extraCIDRs` (Sentry ingest, OTLP collector, med-tracker upstream). Before enabling in a new cluster, confirm the `podLabels` in `values.yaml` match your Postgres, Redis, and MLflow installs (Bitnami charts use `app.kubernetes.io/name: postgresql` / `redis` / `mlflow`).

**On-call.** Probe liveness at `/livez`, readiness at `/readyz`, and aggregate status at `/healthz`. `/livez` always returns 200 while the event loop is responsive (process-up signal only). `/readyz` returns 200 only when the database is reachable and at least one model is loaded; it returns 503 otherwise so Kubernetes removes the pod from Service endpoints. Redis is treated as a soft dependency by default because predict and cohort routes still serve without it; set `ADHERENCE_READYZ_REQUIRE_REDIS=true` in environments where async queues are on the critical path. `/healthz` always returns 200 with a JSON `status` field of `ok` or `degraded` and is kept for dashboards that depend on the 200; do not point Kubernetes probes at it. Scrape `/metrics` for request volume, latency, queue depth, calibration drift, and rate-limit rejects. Drift alerts fire to `ADHERENCE_DRIFT_WEBHOOK_URL` when PSI crosses `ADHERENCE_DRIFT_PSI_THRESHOLD` (default 0.2). Rotate API keys via `ADHERENCE_API_KEYS` (`role:key` pairs); JWT signing key is `ADHERENCE_JWT_SECRET` (minimum 16 chars, enforced at boot). After model promotion regressions, roll back with `POST /v1/admin/models/{name}/rollback`.

**Data subject requests (GDPR).** Subject access and erasure are served at:

* `GET    /v1/users/{user_id}/data`  returns every row that references the user across `predictions`, `prediction_audit`, `dose_outcomes`, `intervention_deliveries`, `user_mutes`, `quiet_hours_policies`, `notification_budgets`, `user_risk_policies` (scope `user`), `experiment_exposures`, and `experiment_events`. Response is JSON with per-table row counts and a stable schema so snapshots can be diffed.
* `DELETE /v1/users/{user_id}/data`  hard-deletes the same set inside a single transaction and returns per-table delete counts. Idempotent: a second call returns zero. Aggregate `training_runs` rows are intentionally retained because they no longer identify the subject after row-level deletion; trigger `POST /v1/train/async` afterwards if a re-fit without the user's data is required.

Both endpoints require either the `admin` role or a DB-issued API key carrying `gdpr:read` (export) or `gdpr:erase` (delete). Every call is structured-logged with `caller`, `request_id`, and per-table counts so the access can be reconstructed from log retention. Verify the data subject's identity out-of-band before invoking these endpoints.

**Dashboard security headers + inspector.** The Next.js dashboard stamps a full OWASP secure-headers baseline on every response from a single Edge middleware (`apps/web/middleware.ts` -> `apps/web/lib/security-headers.ts`): a strict nonce-based `Content-Security-Policy` (`'strict-dynamic'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`), `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (preload-list ready, auto-off in dev or with `ADHERENCE_DISABLE_HSTS=1`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-Permitted-Cross-Domain-Policies: none`, `Origin-Agent-Cluster: ?1`, and a hardened `Permissions-Policy` that denies camera, microphone, geolocation, payment, USB, serial, HID, MIDI, and ~20 other powerful APIs. API routes (`/api/*`, `/v1/*`, `/scim/*`) get a tighter JSON-flavoured CSP (`default-src 'none'`), and the public share viewer (`/share/*`) is the only path that relaxes `frame-ancestors` for partner embedding. Extra `connect-src` origins for tenant telemetry can be added with `ADHERENCE_CSP_CONNECT_SRC="https://t.acme.com,https://api.acme.com"`; junk values are validated out. Procurement reviewers can self-serve verification at `/settings/security-headers`, which calls `GET /api/security-headers?path=/foo` (auth required) and renders the exact header set, a scorecard of OWASP checks, and a copy button per header so the answer can be pasted into a vendor questionnaire without an external scanner. Contract is locked by `apps/web/tests/security-headers.test.ts` (vitest).

**Browser security headers (API).** Every API response carries a hardened header set from `SecurityHeadersMiddleware`: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, and a `Permissions-Policy` that disables camera, microphone, geolocation, payment, USB, magnetometer, gyroscope, and accelerometer. HSTS is opt-in: set `ADHERENCE_HSTS_ENABLED=true` in environments served over TLS (tune `ADHERENCE_HSTS_MAX_AGE_SECONDS`, `ADHERENCE_HSTS_INCLUDE_SUBDOMAINS`, `ADHERENCE_HSTS_PRELOAD`). Keep it off in local dev so plain-HTTP `curl` flows are unaffected. `ADHERENCE_CSP_POLICY` is empty by default because the API returns JSON and PNG only and the Next.js front end enforces its own CSP at the edge; set it to a full policy string to emit a global `Content-Security-Policy` header. The middleware never overwrites a header that an upstream proxy or a specific route already set, so per-response CSP overrides keep working. Disable the whole middleware with `ADHERENCE_SECURITY_HEADERS_ENABLED=false` if a fronting reverse proxy already injects the same set.

**Request body size limit.** `BodySizeLimitMiddleware` caps inbound POST/PUT/PATCH bodies and returns HTTP 413 (`{"detail": "request body too large", "limit_bytes": <int>, "received_bytes": <int>}`) above the threshold. Two enforcement paths: a fast `Content-Length` check that rejects oversize requests before the body is read, and a streaming tally that wraps the ASGI receive callable for chunked uploads where `Content-Length` is missing or untrusted. Global default is 1 MiB via `ADHERENCE_MAX_BODY_BYTES` (Helm: `env.ADHERENCE_MAX_BODY_BYTES`), which fits a several-thousand-dose schedule with headroom. Per-route overrides ship with the `with_max_body(n)` decorator from `adherence_api.body_size_middleware`; attach it above an endpoint to raise the cap on cohort bulk imports or lower it on admin write paths. Health probes (`/livez`, `/healthz`, `/readyz`), `/metrics`, and OpenAPI paths are exempt so liveness stays green even with a misconfigured tiny limit. Disable the whole middleware with `ADHERENCE_BODY_SIZE_LIMIT_ENABLED=false` if a fronting reverse proxy (nginx `client_max_body_size`, Envoy `max_request_bytes`) already enforces the cap. Rejected requests are structured-logged with path, method, observed bytes, and the configured limit, and are counted in the `adherence_api_requests_total{status="413"}` Prometheus series so a sudden spike in 413s is visible on the same dashboard as 5xx.

**Admin-plane audit log.** Every privileged mutation on `/v1/admin/*` and `/v1/users/{user_id}/data` writes a row to `admin_audit_log` via `record_admin_action()` in `adherence_common.admin_audit`. Captured actions: `token.mint`, `api_key.create`, `api_key.revoke`, `model.rollback`, `retention.sweep`, and `gdpr.erase`. Each row stores `tenant_id`, `request_id`, `action`, `target` (api key name, model name, or user_id), `caller`, `caller_role`, `ok`, `error`, and a redacted JSON `details` blob with request-shaped context. Failed authorisation and validation paths record `ok=false` rows so denied attempts are auditable, not just successful ones. The redactor scrubs `key`, `api_key`, `token`, `secret`, `password`, `authorization`, `x-api-key`, `cookie`, and `dsn` fields (case insensitive, walks nested dicts and lists) before persistence, so raw API keys minted by `POST /v1/admin/api-keys` never reach the audit row. Read recent rows with `GET /v1/admin/audit/admin?action=<verb>&caller=<sub>&limit=<n>`; non-admin roles are blocked by `require_admin`. Tenant scoping mirrors the prediction audit reader: callers default to their own tenant, admins may pass `?tenant=<id>` or `?tenant=*` for a cross-tenant compliance read. The recorder swallows its own SQLAlchemy failures (logs a `admin_audit_persist_failed` structured event) so a transient database hiccup never blocks the underlying admin operation; pair the route with the existing `/metrics` request counter to spot audit gaps.

**Audit log tamper evidence.**Every `prediction_audit` row is chained: on insert the recorder reads the previous row's `row_hash`, stores it in `prev_hash`, then writes `row_hash = sha256(canonical_payload(row) + prev_hash)`. Hashed fields cover `id`, `request_id`, `route`, `user_id`, `caller`, `caller_role`, `model_name`, `model_version`, shadow model identifiers, dose counts, miss-probability summaries, `shadow_max_divergence`, `ok`, `error`, `response_summary`, and `created_at`. Latency is excluded so environment jitter does not invalidate the chain. Compliance jobs verify integrity with `GET /v1/audit/verify` (admin only); the response carries `n_rows`, `n_hashed`, `head_hash`, and a `breaks` list of `{row_id, reason, expected, actual}`. `reason` is `row_hash_mismatch` (a row was edited in place) or `prev_hash_mismatch` (a row was deleted or reordered). Rows written before this feature shipped have NULL `row_hash` values and are tolerated as long as the next chained row restarts with `prev_hash = NULL`; back-fill them out-of-band if a fully covered chain is required for an audit window.

**Prometheus monitoring.** The api process renders text exposition at `GET /metrics` via `adherence_common.prom` (no auth: lock down with `networkPolicy`). The Helm chart ships first-class Prometheus Operator wiring under `monitoring.*`, all disabled by default so vanilla clusters render cleanly. Enable per environment:

* `monitoring.serviceMonitor.enabled=true` installs a `ServiceMonitor` (CRD `monitoring.coreos.com/v1`) selecting the api Service on the named `http` port, scraping `/metrics` every `monitoring.serviceMonitor.interval` (30s default). Set `monitoring.serviceMonitor.additionalLabels.release=<kube-prometheus-stack release>` so the Operator's `serviceMonitorSelector` picks it up. `relabelings` and `metricRelabelings` are pass-through for custom topology labels.
* `monitoring.prometheusRule.enabled=true` installs a `PrometheusRule` with five alerts wired to real metrics emitted by `adherence_common.prom`: `AdherenceApiHighErrorRate` (5xx ratio from `adherence_api_requests_total{status=~"5.."}`), `AdherenceApiHighLatencyP95` (p95 from `adherence_api_request_duration_ms_bucket`), `AdherenceApiNoTraffic`, `AdherenceApiNoModelLoaded` (from the `adherence_model_loaded` gauge), and `AdherenceApiTargetDown`. Thresholds live in `monitoring.prometheusRule.thresholds.*` (error rate 5 percent for 10m, p95 750ms for 10m, scrape down 5m) and can be tuned without forking the template.
* `monitoring.podAnnotations.enabled=true` and `monitoring.serviceAnnotations.enabled=true` add `prometheus.io/scrape`, `prometheus.io/path=/metrics`, and `prometheus.io/port=7421` for classic kubernetes_sd scrape configs that do not use the Operator. Leave both off when the Operator is in use to avoid duplicate scrapes.

When `networkPolicy.enabled=true`, ingress from the Operator's Prometheus pods is already permitted via `networkPolicy.api.allowPrometheusScrape=true` and `networkPolicy.api.prometheusNamespaceLabels` (defaults to `name: monitoring`). Render and diff the chart with `helm template adh infra/helm/adherence-ml --set monitoring.serviceMonitor.enabled=true --set monitoring.prometheusRule.enabled=true` to inspect the manifests before applying. Chart sanity is enforced by `tests/unit/test_helm_monitoring.py`, which renders the chart with `helm template` and asserts every alert references a metric defined in `adherence_common.prom`.

**Pod and container hardening.** The Helm chart applies a Pod Security Standards "restricted" posture to every Deployment (`api`, `worker`, `trainer`) by default. Pods run as non-root uid 1001 with `fsGroup` 1001 and `seccompProfile: RuntimeDefault`; containers drop all Linux capabilities, block privilege escalation, and mount the root filesystem read-only. Scratch space for `/tmp` and framework caches is backed by `emptyDir` volumes declared in `securityContext.writableDirs` so a read-only rootfs stays usable without surrendering write access to the image layers. Defaults match what `infra/docker/Dockerfile` already prepares (uid 1001, `libgomp1` only, no shell tooling beyond what XGBoost and LightGBM need at runtime). Disable per environment with `--set securityContext.enabled=false` only if the target cluster cannot honor PSA restricted (older PSP setups requiring privileged sidecars). Tune the writable mounts via `securityContext.writableDirs[].sizeLimit` when batch trainer caches need more than the default 64 MiB. Chart rendering is pinned by `tests/unit/test_helm_security_context.py`, which asserts every rendered Deployment carries `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation=false`, dropped capabilities, and a writable `/tmp` mount.

**Supply chain security.** CI (`.github/workflows/ci.yml`, gated on repo variable `ENABLE_CI=1`) runs four security jobs in parallel with the unit tests, all required before the Docker build can run:

* `pip-audit` resolves the full uv environment and scans every installed Python dependency against the PyPI advisory database. JSON report uploaded as the `pip-audit-report` artifact (30-day retention). New CVEs surface on the run summary without blocking unrelated merges.
* `bandit` runs SAST on `packages/` and `services/` with `bandit.yaml` (excludes tests, vendored code, the web UI, and infra). Severity gate is MEDIUM (`-ll`); the build fails on any medium or high finding. Justified false positives are annotated inline with `# nosec BXXX` and a one-line reason. JSON report uploaded as `bandit-report`.
* `sbom` generates a CycloneDX 1.5 SBOM (`sbom.cdx.json`) for the resolved runtime environment via `cyclonedx-py environment`. Uploaded with 90-day retention for SOC2 evidence and downstream vuln triage.
* `trivy` rebuilds `adherence-ml:ci` and scans the image for HIGH and CRITICAL OS + library vulnerabilities, ignoring unfixed. SARIF output uploaded as `trivy-sarif` for GitHub code scanning integration.

The `docker` and `trivy` jobs depend on `pip-audit` and `bandit` passing, so a known-vulnerable build never reaches a published image. Workflow shape and bandit config are pinned by `tests/unit/test_ci_security.py`, which fails locally if a required job, gate, dependency, or artifact upload is removed. To run the same gates locally before pushing:

```
uv run bandit -c bandit.yaml -r packages services -ll
uv pip install pip-audit cyclonedx-bom
uv run pip-audit --strict
uv run cyclonedx-py environment --output-format JSON --output-file sbom.cdx.json
```

**CORS hardening.** The API mounts FastAPI `CORSMiddleware` with explicit allowlists wired to settings: `ADHERENCE_API_CORS_ORIGINS`, `ADHERENCE_API_CORS_METHODS`, `ADHERENCE_API_CORS_HEADERS`, `ADHERENCE_API_CORS_ALLOW_CREDENTIALS`, and `ADHERENCE_API_CORS_MAX_AGE_SECONDS`. List values accept comma-separated env strings (`ADHERENCE_API_CORS_ORIGINS="https://app.example.com,https://admin.example.com"`). Two boot-time guards live on the pydantic settings model. First, the combination `api_cors_origins=["*"]` plus `api_cors_allow_credentials=true` is rejected because browsers reject the response anyway per the Fetch spec and shipping that config silently breaks every credentialed XHR. Second, when `ADHERENCE_ENV=prod` the validator refuses `["*"]` for origins, methods, or headers so a misconfigured prod deploy fails to start instead of silently exposing the API to every origin. The Helm chart ships `ADHERENCE_ENV=prod` plus an explicit origin (`https://adherence.example.com`) and a curated method/header allowlist; override per environment via `--set-string env.ADHERENCE_API_CORS_ORIGINS=...`. The middleware exposes `X-Request-ID` so browser clients can correlate against server logs without an extra preflight. Dev defaults remain permissive (`*` origins, no credentials) so local `curl` and the Next.js dev server keep working. Unit coverage in `tests/unit/test_cors.py` exercises both validators and asserts the running app echoes allowed origins while ignoring disallowed ones.

**Multi-tenant scoping.** Every PII-bearing write stamps a `tenant_id` (default `"default"`) from the calling principal so audit, predictions, and intervention deliveries can be filtered without cross-tenant leakage. Tenants land on the principal three ways: DB-issued API keys carry `tenant_id` set at creation time via `POST /v1/admin/api-keys` (`{"name": ..., "role": ..., "tenant_id": "acme"}`) and surface again on `GET /v1/admin/api-keys`; JWTs minted via `POST /v1/admin/token` accept a `tenant` field that becomes the `tenant` claim and is read back on every request; legacy env-mapped keys in `ADHERENCE_API_KEYS` fall through to `ADHERENCE_DEFAULT_TENANT`. The audit reader `GET /v1/audit/list` and exporter `GET /v1/audit/export.csv` default to the caller's tenant and accept `?tenant=<id>` only when the caller is admin role; admins may pass `?tenant=*` for a cross-tenant compliance read. Non-admin callers asking for a tenant other than their own get HTTP 403 with an explicit `tenant mismatch` detail. Tenant id is included in the tamper-evident audit hash chain so swapping a row's tenant after the fact breaks `GET /v1/audit/verify`. New columns are added in place by `init_db()` via an idempotent inspector-driven `ALTER TABLE` so existing deployments converge without a separate alembic step; pre-existing rows get the `default` tenant.

**Workspace session policy UI.** The per-tenant session max-age cap shipped at `/v1/workspace/session-policy` now has a dashboard surface at `/settings/session-policy`. Admins see the current cap (or a `global` badge when no override is set), the last change timestamp, and the operator who made it. The form composes minutes/hours/days into seconds, validates client-side against the server's `min_allowed_seconds` / `max_allowed_seconds` envelope, and refuses to submit out-of-range values before a round trip. A `dry run` button posts `?dry_run=true` and renders the would-be payload without writing, so a compliance reviewer can preview the change. A `clear cap` button falls back to the global default after a confirm. The Next.js proxy at `apps/web/app/api/workspace/session-policy/route.ts` forwards `x-request-id` for log stitching and `X-MFA-Code` for admin MFA challenges, surfaces upstream `401` with a clear `Admin MFA required` hint, and bubbles structured upstream error bodies verbatim. Validation lives in zod against the same `[5 minutes, 30 days]` envelope the FastAPI route enforces, so a malformed payload is rejected at the proxy with `{detail, issues}` and never reaches the API. Coverage in `apps/web/tests/workspace-session-policy-route.test.ts` proves invalid JSON, below-floor and above-ceiling values, MFA + dry-run forwarding, and verbatim error bubbling.

### Try it

```
cd apps/web && pnpm dev
# then open
open http://localhost:3000/settings/session-policy
# read the policy via the proxy
curl -s http://localhost:3000/api/workspace/session-policy | jq
# set an 8-hour cap (admin MFA forwarded when needed)
curl -s -X PUT http://localhost:3000/api/workspace/session-policy \
  -H 'content-type: application/json' \
  -H 'x-mfa-code: 123456' \
  -d '{"max_age_seconds": 28800}' | jq
```

## License

MIT. See `LICENSE`.


