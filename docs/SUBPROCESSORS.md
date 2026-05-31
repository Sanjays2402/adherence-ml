# Subprocessors

These are the third parties that may process customer data on our
behalf. Customers are notified through the Trust Center at `/trust`
at least 30 days before a new subprocessor takes effect.

| Subprocessor | Purpose | Data categories | Region |
|--------------|---------|-----------------|--------|
| AWS (RDS, S3, ECS) | Primary hosting, managed Postgres, object storage | All customer data | us-east-1 default, eu-west-1 for EU residency |
| Cloudflare | CDN, WAF, DDoS mitigation, TLS termination | Request metadata, IPs | Global edge, no log retention beyond 24 h |
| Resend | Transactional email (invites, alerts, password resets) | Recipient email, message body | us-east-1 |
| Sentry (self-hosted) | Application error monitoring | Stack traces, redacted request metadata | Same region as primary |
| Stripe | Billing and seat management | Workspace owner email, billing address | Stripe-managed |

## Data-residency promise

Workspaces declare a residency hint (`us`, `eu`) on creation. The API
echoes the active region in the `X-Data-Residency` response header and
the `/v1/admin/workspace/region` endpoint. Primary storage and worker
fleets are pinned to that region; only subprocessors marked global
above may see metadata outside it.

## Removing a subprocessor

If a customer requires removal of a specific subprocessor, contact
**privacy@adherence.ml** and we will scope an alternative deployment
or, for self-hosted plans, document the bypass.
