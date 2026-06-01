"use client";

import Link from "next/link";
import useSWR from "swr";
import {
  ShieldCheck,
  ShieldWarning,
  CheckCircle,
  Warning,
  XCircle,
  Key,
  Users,
  Lock,
  Globe,
  ClipboardText,
  FileLock,
  ArrowSquareOut,
  Pulse,
  Clock,
  Database,
  Receipt,
  Envelope,
  Buildings,
  ListChecks,
  Eye,
  Download,
  Code,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Badge,
  Skeleton,
  ErrorBox,
  Button,
  MonoChip,
} from "@/components/ui/primitives";

type CheckStatus = "pass" | "warn" | "fail" | "unknown";

type PostureCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

type Posture = {
  overall: CheckStatus;
  checks: PostureCheck[];
  generated_at: string;
  version: string | null;
  region: string;
};

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`request failed (${r.status})`);
  return r.json();
};

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "pass")
    return <CheckCircle size={18} weight="duotone" className="text-[var(--color-success)]" />;
  if (status === "warn")
    return <Warning size={18} weight="duotone" className="text-[var(--color-warn)]" />;
  if (status === "fail")
    return <XCircle size={18} weight="duotone" className="text-[var(--color-danger)]" />;
  return <ShieldWarning size={18} weight="duotone" className="text-[var(--color-muted)]" />;
}

function tone(status: CheckStatus): "success" | "warn" | "danger" | "neutral" {
  if (status === "pass") return "success";
  if (status === "warn") return "warn";
  if (status === "fail") return "danger";
  return "neutral";
}

const CONTROLS: {
  group: string;
  icon: React.ComponentType<{ size?: number; weight?: "duotone"; className?: string }>;
  items: { title: string; body: string; href?: string }[];
}[] = [
  {
    group: "Identity and access",
    icon: Key,
    items: [
      {
        title: "SSO via OIDC and SAML",
        body: "Workspaces can require SSO through Google Workspace, Okta, or Azure AD. Just-in-time provisioning with domain auto-join is available.",
        href: "/workspace/sso",
      },
      {
        title: "Role-based access control",
        body: "Owner, admin, member, and viewer roles checked on every API route. DB-backed API keys carry fine-grained scopes on top of the role.",
        href: "/workspace",
      },
      {
        title: "TOTP for privileged actions",
        body: "Admin mutations require a fresh TOTP code in addition to the session cookie. Force-logout-all-sessions is one click in settings.",
        href: "/settings/security",
      },
      {
        title: "Per-key IP allowlist",
        body: "Each API key can be pinned to a CIDR range. Middleware enforces the allowlist before any business logic runs.",
        href: "/settings/ip-allowlist",
      },
    ],
  },
  {
    group: "Tenancy and data",
    icon: Buildings,
    items: [
      {
        title: "Strict multi-tenancy",
        body: "Every row is scoped by workspace_id. Cross-tenant access requires the admin role and is logged. Unit tests assert isolation.",
      },
      {
        title: "Declared data residency",
        body: "Workspaces pick us or eu on creation. The active region echoes back in the X-Data-Residency response header on every API call.",
      },
      {
        title: "Configurable retention",
        body: "Per-workspace runs retention policy with a safe purge job. Hard-delete of an account wipes predictions, audit chain links, and webhook deliveries scoped to that tenant.",
        href: "/settings",
      },
      {
        title: "GDPR and CCPA export",
        body: "Workspace owners can export every row we hold for them as JSON or CSV from the settings page, no support ticket required.",
      },
    ],
  },
  {
    group: "Audit and observability",
    icon: ListChecks,
    items: [
      {
        title: "Tamper-evident audit log",
        body: "Every mutation writes actor, role, source IP, request id, and a before and after diff into a hash-chained admin_audit_log. Chain verify endpoint is exposed and the log streams to your SIEM as CSV.",
        href: "/audit",
      },
      {
        title: "Authentication lifecycle events",
        body: "Sign-in, sign-out, MFA challenge, SSO bind, and key rotation events sit in the same tamper-evident chain.",
        href: "/settings/auth-events",
      },
      {
        title: "Structured JSON logs and Prometheus",
        body: "Request id propagates from edge through FastAPI. /metrics exposes Prometheus counters and histograms. /healthz and /readyz back the Kubernetes probes.",
        href: "/metrics",
      },
    ],
  },
  {
    group: "Abuse and rate control",
    icon: Pulse,
    items: [
      {
        title: "Rate limits and quotas",
        body: "Per-key and per-workspace limits return 429 with Retry-After plus standard X-RateLimit headers. Per-workspace monthly prediction quotas are billed-plan aware.",
        href: "/workspace/quota",
      },
      {
        title: "Signed outbound webhooks",
        body: "HMAC-SHA256 on every delivery, retries with exponential backoff, delivery log with replay, and a host allowlist that blocks SSRF to private networks by default.",
        href: "/webhooks",
      },
      {
        title: "Dry-run on every destructive route",
        body: "Append ?dry_run=true to any state-changing /v1 endpoint to see what would happen without committing it.",
      },
    ],
  },
];

const SUBPROCESSORS = [
  { name: "AWS", purpose: "Hosting, Postgres, object storage", region: "us-east-1 default" },
  { name: "Cloudflare", purpose: "CDN, WAF, TLS termination", region: "Global edge" },
  { name: "Resend", purpose: "Transactional email", region: "us-east-1" },
  { name: "Sentry (self-hosted)", purpose: "Error monitoring", region: "Pinned to primary" },
  { name: "Stripe", purpose: "Billing and seats", region: "Stripe-managed" },
];

export default function TrustClient() {
  const { data, error, isLoading, mutate } = useSWR<Posture>(
    "/api/trust/posture",
    fetcher,
    { refreshInterval: 60_000 },
  );

  const overall = data?.overall ?? "unknown";
  const overallLabel =
    overall === "pass"
      ? "All controls reporting healthy"
      : overall === "warn"
        ? "Operational with advisories"
        : overall === "fail"
          ? "Action required"
          : "Posture unknown";

  return (
    <div className="min-h-screen">
      <PageHeader
        eyebrow="trust center"
        title="Security and compliance"
        description="The controls, posture, and policies that let security and procurement teams evaluate adherence.ml without filing a ticket."
        actions={
          <>
            <Link href="/.well-known/security.txt" target="_blank" rel="noopener">
              <Button variant="ghost">
                <FileLock size={16} weight="duotone" />
                security.txt
                <ArrowSquareOut size={12} />
              </Button>
            </Link>
            <a href="mailto:security@adherence.ml">
              <Button variant="ghost">
                <Envelope size={16} weight="duotone" />
                Report a vulnerability
              </Button>
            </a>
          </>
        }
      />

      <div className="p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Live posture"
            hint="Refreshed every 60 seconds from this deployment"
            right={
              <div className="flex items-center gap-2">
                <Badge tone={tone(overall)}>
                  {overall === "pass" ? (
                    <ShieldCheck size={11} weight="duotone" />
                  ) : (
                    <ShieldWarning size={11} weight="duotone" />
                  )}
                  {overall}
                </Badge>
                <button
                  onClick={() => mutate()}
                  className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                  aria-label="Refresh posture"
                >
                  refresh
                </button>
              </div>
            }
          />
          <div className="p-4">
            <div className="text-[13px] text-[var(--color-muted)] mb-3">{overallLabel}</div>
            {error ? (
              <ErrorBox message="Could not load live posture. The endpoint is open but unreachable from this browser." />
            ) : isLoading || !data ? (
              <div className="space-y-2" aria-busy="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : data.checks.length === 0 ? (
              <div className="text-[13px] text-[var(--color-muted)]">No checks reported.</div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {data.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 py-2.5">
                    <StatusIcon status={c.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium">{c.label}</div>
                      <div className="text-[12px] text-[var(--color-muted)] mt-0.5 break-words">
                        {c.detail}
                      </div>
                    </div>
                    <Badge tone={tone(c.status)}>{c.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {data ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)]">
                <MonoChip>region {data.region}</MonoChip>
                {data.version ? <MonoChip>api {data.version}</MonoChip> : null}
                <span>generated {new Date(data.generated_at).toISOString()}</span>
              </div>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader title="Disclosure" hint="How to reach us with a vulnerability" />
          <div className="p-4 space-y-3 text-[13px]">
            <p className="text-[var(--color-muted)] leading-relaxed">
              We acknowledge critical reports within one business day and aim to mitigate within seven calendar days. Safe-harbor terms and severity tiers live in <Link href="https://github.com/Sanjays2402/adherence-ml/blob/main/SECURITY.md" className="text-[var(--color-accent)] underline">SECURITY.md</Link>.
            </p>
            <div className="rounded border border-[var(--color-border-strong)] bg-[var(--color-border)]/30 p-3 font-mono text-[12px]">
              security@adherence.ml
            </div>
            <ul className="space-y-1.5 text-[12px] text-[var(--color-muted)]">
              <li className="flex items-center gap-2">
                <Clock size={14} weight="duotone" /> 1 business day acknowledgement on critical
              </li>
              <li className="flex items-center gap-2">
                <Lock size={14} weight="duotone" /> PGP key available on request
              </li>
              <li className="flex items-center gap-2">
                <Eye size={14} weight="duotone" /> Default 90-day coordinated disclosure
              </li>
            </ul>
          </div>
        </Card>
      </div>

      <div className="px-4 md:px-6 pb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {CONTROLS.map((group) => {
          const Icon = group.icon;
          return (
            <Card key={group.group}>
              <CardHeader
                title={group.group}
                right={<Icon size={18} weight="duotone" className="text-[var(--color-accent)]" />}
              />
              <ul className="divide-y divide-[var(--color-border)]">
                {group.items.map((item) => (
                  <li key={item.title} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-[13px] font-medium">{item.title}</div>
                      {item.href ? (
                        <Link
                          href={item.href}
                          className="shrink-0 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-accent)] hover:underline"
                        >
                          open
                          <ArrowSquareOut size={11} className="inline ml-0.5" />
                        </Link>
                      ) : null}
                    </div>
                    <p className="text-[12px] text-[var(--color-muted)] leading-relaxed mt-1.5">
                      {item.body}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      <div className="px-4 md:px-6 pb-10 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Subprocessors"
            hint="Notified 30 days before any change"
            right={
              <Link
                href="https://github.com/Sanjays2402/adherence-ml/blob/main/docs/SUBPROCESSORS.md"
                className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-accent)] hover:underline"
                target="_blank"
                rel="noopener"
              >
                full list
                <ArrowSquareOut size={11} className="inline ml-0.5" />
              </Link>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-normal">Vendor</th>
                  <th className="px-4 py-2 font-normal">Purpose</th>
                  <th className="px-4 py-2 font-normal">Region</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {SUBPROCESSORS.map((s) => (
                  <tr key={s.name}>
                    <td className="px-4 py-2.5 font-medium">{s.name}</td>
                    <td className="px-4 py-2.5 text-[var(--color-muted)]">{s.purpose}</td>
                    <td className="px-4 py-2.5">
                      <Badge>{s.region}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader title="Policies" hint="Source of truth" />
          <ul className="p-2">
            {[
              {
                icon: ClipboardText,
                href: "https://github.com/Sanjays2402/adherence-ml/blob/main/SECURITY.md",
                label: "Vulnerability disclosure policy",
              },
              {
                icon: Database,
                href: "https://github.com/Sanjays2402/adherence-ml/blob/main/docs/THREAT_MODEL.md",
                label: "Threat model (STRIDE)",
              },
              {
                icon: Users,
                href: "https://github.com/Sanjays2402/adherence-ml/blob/main/docs/SUBPROCESSORS.md",
                label: "Subprocessor list",
              },
              {
                icon: Globe,
                href: "/.well-known/security.txt",
                label: "/.well-known/security.txt",
              },
              {
                icon: Receipt,
                href: "https://github.com/Sanjays2402/adherence-ml/blob/main/CODEOWNERS",
                label: "Code owners",
              },
            ].map((p) => {
              const Icon = p.icon;
              return (
                <li key={p.href}>
                  <Link
                    href={p.href}
                    target={p.href.startsWith("http") || p.href.endsWith(".txt") ? "_blank" : undefined}
                    rel="noopener"
                    className="flex items-center gap-2.5 rounded px-3 py-2 text-[13px] hover:bg-[var(--color-border)]/40 focus:outline-none focus:bg-[var(--color-border)]/60"
                  >
                    <Icon size={16} weight="duotone" className="text-[var(--color-accent)] shrink-0" />
                    <span className="flex-1 min-w-0 truncate">{p.label}</span>
                    <ArrowSquareOut size={12} className="text-[var(--color-muted)] shrink-0" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <div id="manifest" className="px-4 md:px-6 pb-6">
        <Card>
          <CardHeader
            title="Machine-readable trust manifest"
            hint="For procurement scanners and security questionnaire automation"
          />
          <div className="p-4 space-y-3 text-[13px] text-[var(--color-muted)]">
            <p>
              Pull the same posture this page renders, as a stable JSON
              document your vendor-review pipeline can ingest. The
              schema is versioned. Pin to{" "}
              <span className="font-mono text-[var(--color-fg)]">schema_version</span>{" "}
              and fail loudly if a future release breaks the contract.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="/api/well-known/security.json"
                download="adherence-ml-trust-manifest.json"
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)]"
              >
                <Download size={14} weight="duotone" />
                Download security.json
              </a>
              <a
                href="/api/well-known/security.json"
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)]"
              >
                <Code size={14} weight="duotone" />
                View raw JSON
              </a>
              <a
                href="/api/well-known/security.txt"
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)]"
              >
                <FileLock size={14} weight="duotone" />
                security.txt (RFC 9116)
              </a>
            </div>
            <pre className="text-[11.5px] leading-relaxed font-mono bg-[var(--color-bg-subtle)] border border-[var(--color-border)] rounded-md p-3 overflow-x-auto">
{`curl -s https://api.adherence.ml/.well-known/security.json | jq .schema_version
# "1.0.0"`}
            </pre>
          </div>
        </Card>
      </div>

      <div id="acknowledgments" className="px-4 md:px-6 pb-12">
        <Card>
          <CardHeader title="Acknowledgments" hint="Researchers who improved our posture" />
          <div className="p-4 text-[13px] text-[var(--color-muted)]">
            None yet. Be the first. Reports to <span className="font-mono text-[var(--color-fg)]">security@adherence.ml</span>.
          </div>
        </Card>
      </div>
    </div>
  );
}
