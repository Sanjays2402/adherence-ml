"use client";

import useSWR from "swr";
import {
  ShieldCheck,
  ShieldWarning,
  Plugs as PlugsIcon,
  GlobeHemisphereWest,
  Lock,
  Info,
  ArrowsClockwise,
} from "@phosphor-icons/react";

import {
  PageHeader,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
  MonoChip,
  Stat,
} from "@/components/ui/primitives";

type SourceRow = {
  source: string;
  signed: boolean;
  rotation_pending?: boolean;
  secret_count?: number;
  ip_restricted: boolean;
  allowed_cidrs: string[];
};

type InboundConfig = {
  require_signed: boolean;
  max_skew_seconds: number;
  sources: SourceRow[];
};

async function fetcher(url: string): Promise<InboundConfig> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body === "object" && "detail" in body) {
        detail = String((body as { detail: unknown }).detail);
      }
    } catch {
      // keep status text
    }
    throw new Error(detail);
  }
  return (await res.json()) as InboundConfig;
}

function rowTone(row: SourceRow, requireSigned: boolean): {
  tone: "success" | "warn" | "danger";
  label: string;
} {
  if (row.signed && row.ip_restricted) {
    return { tone: "success", label: "hardened" };
  }
  if (row.signed) return { tone: "success", label: "signed" };
  if (requireSigned) return { tone: "danger", label: "blocked" };
  return { tone: "warn", label: "unsigned" };
}

export default function InboundWebhooksClient() {
  const { data, error, isLoading } = useSWR<InboundConfig>(
    "/api/webhooks/inbound-config",
    fetcher,
    { revalidateOnFocus: false },
  );

  const totalSources = data?.sources.length ?? 0;
  const signedCount = data?.sources.filter((s) => s.signed).length ?? 0;
  const ipCount = data?.sources.filter((s) => s.ip_restricted).length ?? 0;
  const rotatingCount = data?.sources.filter((s) => s.rotation_pending).length ?? 0;

  return (
    <main className="min-h-dvh">
      <PageHeader
        eyebrow="webhooks"
        title="Inbound posture"
        description="Partner systems that POST dose-outcome events here. Verify that every production source is HMAC signed and, where possible, restricted to a known egress CIDR."
        actions={
          data ? (
            <Badge tone={data.require_signed ? "success" : "warn"}>
              {data.require_signed
                ? "require signed: on"
                : "require signed: off"}
            </Badge>
          ) : null
        }
      />

      <div className="px-4 sm:px-6 py-6 space-y-6 max-w-5xl">
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat
            label="sources"
            value={isLoading ? "—" : totalSources}
            sub="configured partners"
          />
          <Stat
            label="signed"
            value={isLoading ? "—" : `${signedCount}/${totalSources || 0}`}
            sub="HMAC envelope verified"
          />
          <Stat
            label="ip restricted"
            value={isLoading ? "—" : `${ipCount}/${totalSources || 0}`}
            sub="allowlist enforced"
          />
          <Stat
            label="rotating"
            value={isLoading ? "—" : rotatingCount}
            sub="dual secret active"
          />
        </section>

        <Card>
          <CardHeader
            title="sources"
            hint={
              data
                ? `max clock skew: ${data.max_skew_seconds}s`
                : "loading posture"
            }
            right={
              <MonoChip>
                <PlugsIcon size={12} weight="duotone" /> /v1/webhooks/&lt;src&gt;
              </MonoChip>
            }
          />

          {isLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorBox message={(error as Error).message} />
            </div>
          ) : !data || data.sources.length === 0 ? (
            <Empty
              icon={<PlugsIcon size={28} weight="duotone" />}
              title="No partner sources configured"
              hint="Add ADHERENCE_INBOUND_WEBHOOK_SECRETS to the API service to register a partner. Each unsigned partner is logged at receive time."
            />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {data.sources.map((row) => {
                const t = rowTone(row, data.require_signed);
                return (
                  <li
                    key={row.source}
                    className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex items-center gap-3">
                      {row.signed ? (
                        <ShieldCheck
                          size={20}
                          weight="duotone"
                          className="text-[var(--color-accent)] shrink-0"
                        />
                      ) : (
                        <ShieldWarning
                          size={20}
                          weight="duotone"
                          className="text-[var(--color-danger)] shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="font-mono text-[13px] truncate">
                          {row.source}
                        </div>
                        <div className="text-[11px] text-[var(--color-muted)] mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="inline-flex items-center gap-1">
                            <Lock size={11} weight="duotone" />
                            {row.signed ? "HMAC required" : "no signature"}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <GlobeHemisphereWest size={11} weight="duotone" />
                            {row.ip_restricted
                              ? `${row.allowed_cidrs.length} CIDR${row.allowed_cidrs.length === 1 ? "" : "s"}`
                              : "any IP"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <Badge tone={t.tone}>{t.label}</Badge>
                      {row.rotation_pending ? (
                        <Badge tone="warn">
                          <span className="inline-flex items-center gap-1">
                            <ArrowsClockwise size={11} weight="duotone" />
                            rotating
                          </span>
                        </Badge>
                      ) : null}
                      {row.ip_restricted ? (
                        <div className="flex flex-wrap gap-1 max-w-full">
                          {row.allowed_cidrs.slice(0, 3).map((c) => (
                            <MonoChip key={c}>{c}</MonoChip>
                          ))}
                          {row.allowed_cidrs.length > 3 ? (
                            <MonoChip>
                              +{row.allowed_cidrs.length - 3}
                            </MonoChip>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="how to harden" />
          <div className="px-4 py-4 text-[13px] text-[var(--color-fg)]/85 space-y-3 leading-relaxed">
            <div className="flex items-start gap-2">
              <Info
                size={14}
                weight="duotone"
                className="text-[var(--color-muted)] mt-0.5 shrink-0"
              />
              <p>
                Set <span className="font-mono">ADHERENCE_INBOUND_WEBHOOK_REQUIRE_SIGNED=1</span> to
                reject any inbound POST without a valid <span className="font-mono">X-Webhook-Signature</span> envelope.
              </p>
            </div>
            <div className="flex items-start gap-2">
              <Info
                size={14}
                weight="duotone"
                className="text-[var(--color-muted)] mt-0.5 shrink-0"
              />
              <p>
                Add per-source secrets via <span className="font-mono">ADHERENCE_INBOUND_WEBHOOK_SECRETS=&quot;source:secret,...&quot;</span> and restrict origin IPs with <span className="font-mono">ADHERENCE_INBOUND_WEBHOOK_IP_ALLOWLIST</span>.
              </p>
            </div>
            <div className="flex items-start gap-2">
              <Info
                size={14}
                weight="duotone"
                className="text-[var(--color-muted)] mt-0.5 shrink-0"
              />
              <p>
                Clock skew above <span className="font-mono">{data?.max_skew_seconds ?? 300}s</span> is rejected to defeat replay. Tune with <span className="font-mono">ADHERENCE_INBOUND_WEBHOOK_MAX_SKEW_SECONDS</span>.
              </p>
            </div>
            <div className="flex items-start gap-2">
              <Info
                size={14}
                weight="duotone"
                className="text-[var(--color-muted)] mt-0.5 shrink-0"
              />
              <p>
                Rotate a partner secret without downtime by setting <span className="font-mono">source:NEW_SECRET|OLD_SECRET</span> in <span className="font-mono">ADHERENCE_INBOUND_WEBHOOK_SECRETS</span>. Both signatures verify while the partner cuts over. Every accepted request signed with the previous secret is logged as <span className="font-mono">inbound_webhook_previous_secret_used</span>; once that count is zero, drop the <span className="font-mono">|OLD_SECRET</span> suffix.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
