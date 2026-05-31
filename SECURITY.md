# Security policy

adherence.ml ships into clinical and clinical-adjacent environments. We
take vulnerability reports seriously and triage them ahead of feature
work.

## Reporting a vulnerability

Email **security@adherence.ml** with a description, reproduction steps,
and any logs or screenshots. PGP is available on request. Please do
not file public GitHub issues for security reports.

If you do not get an acknowledgement within two business days, escalate
to **51058514+Sanjays2402@users.noreply.github.com**.

You may also use the discovery file at
[`/.well-known/security.txt`](apps/web/public/.well-known/security.txt)
or the in-product Trust Center at `/trust`.

## Scope

In scope:

- The hosted API (`*.adherence.ml`) and dashboard
- The reference deployment in `services/api`, `services/inference_worker`,
  `services/trainer`, and `apps/web`
- The published Python SDK in `clients/python`

Out of scope: spam or social engineering, denial-of-service against
shared infrastructure, automated scanner output without a working
proof-of-concept, missing best-practice headers on marketing pages,
and findings in third-party SaaS we do not control.

## Severity and response targets

| Severity | Examples | Acknowledge | Mitigate |
|----------|----------|-------------|----------|
| Critical | Unauthenticated RCE, cross-tenant data leak, auth bypass | 1 business day | 7 calendar days |
| High     | Stored XSS with credential access, privilege escalation | 2 business days | 30 days |
| Medium   | CSRF on a state-changing route, IDOR with limited blast radius | 5 business days | 60 days |
| Low      | Verbose error pages, weak rate limits on non-sensitive endpoints | 10 business days | 90 days |

## Safe harbor

We will not pursue legal action or law-enforcement referral against
researchers who:

1. Make a good-faith effort to avoid privacy violations, data destruction,
   and service interruption.
2. Only interact with their own accounts, accounts they have explicit
   permission to test, or our staging environment.
3. Report the issue privately and give us a reasonable window to fix it
   before public disclosure (default 90 days).

## Encryption and data handling

- TLS 1.2+ enforced end-to-end. HSTS with `includeSubDomains; preload`
  on the dashboard.
- Encryption at rest via the underlying managed Postgres and object
  store. Customer-supplied keys (BYOK) available on enterprise plans.
- Customer data is logically isolated per workspace. Every query path
  is filtered by `workspace_id` and audited. See `docs/THREAT_MODEL.md`.

## Subprocessors

Current list lives in [`docs/SUBPROCESSORS.md`](docs/SUBPROCESSORS.md).
Material changes are announced via the Trust Center 30 days before they
take effect.

## Coordinated disclosure

After a fix ships, we credit researchers in the release notes unless
they prefer to remain anonymous. We do not currently run a paid bug
bounty.
