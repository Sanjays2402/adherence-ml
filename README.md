# adherence-ml

ML risk scoring for medication adherence. Predicts which upcoming doses a user
is likely to miss in the next 24 hours and turns those scores into ranked
interventions.

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
to `POST /v1/webhooks/medtracker/event` on the FastAPI service. Because
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
```

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

**Browser security headers.** Every API response carries a hardened header set from `SecurityHeadersMiddleware`: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, and a `Permissions-Policy` that disables camera, microphone, geolocation, payment, USB, magnetometer, gyroscope, and accelerometer. HSTS is opt-in: set `ADHERENCE_HSTS_ENABLED=true` in environments served over TLS (tune `ADHERENCE_HSTS_MAX_AGE_SECONDS`, `ADHERENCE_HSTS_INCLUDE_SUBDOMAINS`, `ADHERENCE_HSTS_PRELOAD`). Keep it off in local dev so plain-HTTP `curl` flows are unaffected. `ADHERENCE_CSP_POLICY` is empty by default because the API returns JSON and PNG only and the Next.js front end enforces its own CSP at the edge; set it to a full policy string to emit a global `Content-Security-Policy` header. The middleware never overwrites a header that an upstream proxy or a specific route already set, so per-response CSP overrides keep working. Disable the whole middleware with `ADHERENCE_SECURITY_HEADERS_ENABLED=false` if a fronting reverse proxy already injects the same set.

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

## License

MIT. See `LICENSE`.

