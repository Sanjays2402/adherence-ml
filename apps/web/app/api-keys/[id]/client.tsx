"use client";

import useSWR from "swr";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ChartBar,
  Key,
  ArrowLeft,
  Warning,
  Pulse,
  ListChecks,
  ShieldCheck,
  X,
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

type Scope = "predict" | "read" | "webhooks" | "audit";

type KeyMeta = {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  revoked: boolean;
  scopes: Scope[];
  allowed_cidrs?: string[] | null;
};

type UsageEvent = {
  key_id: string;
  ts: number;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
};

type UsageResp = {
  key: KeyMeta;
  total: number;
  last_24h: number;
  last_7d: number;
  daily: Array<{ day: string; count: number }>;
  by_endpoint: Array<{ path: string; count: number }>;
  by_status: Array<{ status: number; count: number }>;
  recent: UsageEvent[];
};

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.detail || `request failed: ${r.status}`);
  }
  return r.json();
};

function fmtTs(ms: number | null): string {
  if (!ms) return "never";
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function statusTone(s: number): "success" | "danger" | "neutral" {
  if (s >= 200 && s < 300) return "success";
  if (s >= 400) return "danger";
  return "neutral";
}

function methodTone(_m: string): "neutral" {
  return "neutral";
}

export default function KeyDetailClient({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useSWR<UsageResp>(
    `/api/keys/${encodeURIComponent(id)}/usage?limit=100`,
    fetcher,
    { refreshInterval: 5000 },
  );

  const maxDaily = data ? Math.max(1, ...data.daily.map((d) => d.count)) : 1;

  // --- CIDR allowlist editor state -----------------------------------------
  const initialList = (data?.key.allowed_cidrs ?? []) as string[];
  const [cidrs, setCidrs] = useState<string[]>(initialList);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Re-sync editor when SWR brings in the canonical list (first load + refresh).
  useEffect(() => {
    if (data?.key) {
      setCidrs((data.key.allowed_cidrs ?? []) as string[]);
    }
  }, [data?.key.id, data?.key.allowed_cidrs?.join(",")]);

  function addDraft() {
    const v = draft.trim();
    if (!v) return;
    if (cidrs.includes(v)) {
      setDraft("");
      return;
    }
    if (cidrs.length >= 32) {
      setSaveMsg({ kind: "err", text: "max 32 entries per key" });
      return;
    }
    setCidrs([...cidrs, v]);
    setDraft("");
    setSaveMsg(null);
  }

  async function saveCidrs(next: string[] | null) {
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await fetch(`/api/keys/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowed_cidrs: next }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.detail || `save failed: ${r.status}`);
      }
      setSaveMsg({ kind: "ok", text: next === null || next.length === 0 ? "pin cleared" : "saved" });
      await mutate();
    } catch (e) {
      setSaveMsg({ kind: "err", text: e instanceof Error ? e.message : "save failed" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        eyebrow="API KEY USAGE"
        title={data?.key.name ?? "key usage"}
        description="Recent requests, 14-day call volume, and endpoint breakdown for this key. Updates every 5 seconds."
        actions={
          <Link
            href="/api-keys"
            className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:border-[var(--color-accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
          >
            <ArrowLeft weight="duotone" size={14} />
            all keys
          </Link>
        }
      />

      <div className="p-6 space-y-6">
        {error ? (
          <ErrorBox message={error instanceof Error ? error.message : "failed to load usage"} />
        ) : null}

        {isLoading && !data ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : null}

        {data ? (
          <>
            {/* Key meta */}
            <Card>
              <CardHeader
                right={<Key weight="duotone" size={16} />}
                title="Key"
                hint="Created, scopes, and current state."
              />
              <div className="px-4 pb-4 flex flex-wrap items-center gap-4 text-[12px]">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--color-muted)]">prefix</span>
                  <MonoChip>{data.key.prefix}...</MonoChip>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--color-muted)]">created</span>
                  <span className="font-mono">{fmtTs(data.key.created_at)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--color-muted)]">last used</span>
                  <span className="font-mono">{fmtTs(data.key.last_used_at)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--color-muted)]">scopes</span>
                  <div className="inline-flex gap-1">
                    {data.key.scopes.map((s) => (
                      <Badge key={s} tone="neutral">{s}</Badge>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {data.key.revoked ? (
                    <Badge tone="danger">revoked</Badge>
                  ) : (
                    <Badge tone="success">active</Badge>
                  )}
                </div>
              </div>
            </Card>

            {/* Source IP allowlist */}
            <Card>
              <CardHeader
                right={<ShieldCheck weight="duotone" size={16} />}
                title="Source IP allowlist"
                hint="Pin this key to specific IPv4 or IPv6 CIDRs. Requests from any other source return 403. Leave empty to allow any IP (the workspace-level allowlist still applies)."
              />
              <div className="px-4 pb-4 space-y-3">
                <div className="flex flex-wrap gap-1.5 min-h-[26px]">
                  {cidrs.length === 0 ? (
                    <span className="text-[11px] text-[var(--color-muted)]">No pin set. Key works from any IP.</span>
                  ) : (
                    cidrs.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 font-mono text-[11px]"
                      >
                        {c}
                        <button
                          type="button"
                          aria-label={`remove ${c}`}
                          onClick={() => setCidrs(cidrs.filter((x) => x !== c))}
                          className="text-[var(--color-muted)] hover:text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] rounded"
                        >
                          <X weight="bold" size={11} />
                        </button>
                      </span>
                    ))
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    inputMode="text"
                    spellCheck={false}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDraft();
                      }
                    }}
                    placeholder="10.0.0.0/8 or 203.0.113.42 or 2001:db8::/32"
                    aria-label="CIDR to add"
                    className="flex-1 min-w-[220px] rounded border border-[var(--color-border)] bg-transparent px-2 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                  />
                  <button
                    type="button"
                    onClick={addDraft}
                    className="text-[12px] px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                  >
                    add
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => saveCidrs(cidrs.length === 0 ? null : cidrs)}
                    className="text-[12px] px-3 py-1.5 rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 hover:bg-[var(--color-accent)]/20 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                  >
                    {saving ? "saving..." : "save"}
                  </button>
                  <button
                    type="button"
                    disabled={saving || ((data.key.allowed_cidrs ?? []).length === 0 && cidrs.length === 0)}
                    onClick={() => {
                      setCidrs([]);
                      void saveCidrs(null);
                    }}
                    className="text-[12px] px-3 py-1.5 rounded border border-[var(--color-border)] hover:bg-[var(--color-surface)] disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                  >
                    clear pin
                  </button>
                </div>
                {saveMsg ? (
                  <div
                    role="status"
                    className={
                      saveMsg.kind === "ok"
                        ? "text-[11px] text-[var(--color-success)]"
                        : "text-[11px] text-[var(--color-danger)]"
                    }
                  >
                    {saveMsg.text}
                  </div>
                ) : null}
              </div>
            </Card>

            {/* Stats */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Stat label="total calls" value={String(data.total)} />
              <Stat label="last 24h" value={String(data.last_24h)} />
              <Stat label="last 7 days" value={String(data.last_7d)} />
            </div>

            {/* Daily chart */}
            <Card>
              <CardHeader
                right={<ChartBar weight="duotone" size={16} />}
                title="Daily call volume"
                hint="UTC days, last 14. Hover a bar for the count."
              />
              <div className="px-4 pb-5">
                {data.total === 0 ? (
                  <Empty
                    icon={<Pulse weight="duotone" size={24} />}
                    title="No calls yet"
                    hint="When this key is used against any /v1/... endpoint, the activity will show up here within a few seconds."
                  />
                ) : (
                  <div className="flex items-end gap-1 h-32" role="img" aria-label="14 day call volume">
                    {data.daily.map((d) => {
                      const h = Math.round((d.count / maxDaily) * 100);
                      return (
                        <div key={d.day} className="flex-1 flex flex-col items-center gap-1 group">
                          <div className="w-full flex items-end" style={{ height: "100%" }}>
                            <div
                              className="w-full rounded-t bg-[var(--color-accent)]/70 group-hover:bg-[var(--color-accent)] transition-colors"
                              style={{ height: `${Math.max(d.count > 0 ? 4 : 0, h)}%` }}
                              title={`${d.day}: ${d.count}`}
                            />
                          </div>
                          <div className="text-[9px] font-mono text-[var(--color-muted)] tabular-nums">
                            {d.day.slice(5)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>

            {/* Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader
                  right={<ListChecks weight="duotone" size={16} />}
                  title="By endpoint"
                  hint="Where the calls landed."
                />
                <div className="px-4 pb-4">
                  {data.by_endpoint.length === 0 ? (
                    <div className="text-[12px] text-[var(--color-muted)] py-2">No traffic yet.</div>
                  ) : (
                    <table className="w-full text-[12px]">
                      <tbody>
                        {data.by_endpoint.map((row) => (
                          <tr key={row.path} className="border-t border-[var(--color-border)] first:border-t-0">
                            <td className="py-2 font-mono">{row.path}</td>
                            <td className="py-2 text-right font-mono tabular-nums">{row.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Card>
              <Card>
                <CardHeader
                  right={<Warning weight="duotone" size={16} />}
                  title="By status"
                  hint="HTTP outcomes. Watch the 4xx column for misuse."
                />
                <div className="px-4 pb-4">
                  {data.by_status.length === 0 ? (
                    <div className="text-[12px] text-[var(--color-muted)] py-2">No traffic yet.</div>
                  ) : (
                    <table className="w-full text-[12px]">
                      <tbody>
                        {data.by_status.map((row) => (
                          <tr key={row.status} className="border-t border-[var(--color-border)] first:border-t-0">
                            <td className="py-2">
                              <Badge tone={statusTone(row.status)}>{String(row.status)}</Badge>
                            </td>
                            <td className="py-2 text-right font-mono tabular-nums">{row.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Card>
            </div>

            {/* Recent requests */}
            <Card>
              <CardHeader
                right={<Pulse weight="duotone" size={16} />}
                title="Recent requests"
                hint="Last 100 calls, newest first."
              />
              <div className="overflow-x-auto">
                {data.recent.length === 0 ? (
                  <Empty
                    icon={<Pulse weight="duotone" size={24} />}
                    title="Nothing recorded yet"
                    hint="Try the copy-paste curl example on the API keys page to send your first call."
                  />
                ) : (
                  <table className="w-full text-[12px]">
                    <thead className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
                      <tr>
                        <th className="px-4 py-2 text-left">when</th>
                        <th className="px-4 py-2 text-left">method</th>
                        <th className="px-4 py-2 text-left">path</th>
                        <th className="px-4 py-2 text-left">status</th>
                        <th className="px-4 py-2 text-right">latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((ev, i) => (
                        <tr key={`${ev.ts}-${i}`} className="border-t border-[var(--color-border)]">
                          <td className="px-4 py-2 font-mono text-[11px] text-[var(--color-muted)]">
                            {fmtTs(ev.ts)}
                          </td>
                          <td className="px-4 py-2">
                            <Badge tone={methodTone(ev.method)}>{ev.method}</Badge>
                          </td>
                          <td className="px-4 py-2 font-mono">{ev.path}</td>
                          <td className="px-4 py-2">
                            <Badge tone={statusTone(ev.status)}>{String(ev.status)}</Badge>
                          </td>
                          <td className="px-4 py-2 text-right font-mono tabular-nums">
                            {ev.latency_ms > 0 ? `${ev.latency_ms} ms` : "--"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}
