"use client";

import React from "react";
import useSWR from "swr";
import { useMemo, useState } from "react";
import {
  ArrowsClockwise,
  ShieldCheck,
  Warning,
  DownloadSimple,
  CaretRight,
  CaretDown,
  SignIn,
  SignOut,
  Key,
  Fingerprint,
} from "@phosphor-icons/react";
import {
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Skeleton,
  Button,
  Badge,
  Select,
  Input,
  PageHeader,
  Stat,
} from "@/components/ui/primitives";

interface AuthEvent {
  id: string;
  ts: number;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  outcome: "success" | "failure" | "denied";
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
  prev_hash: string;
  hash: string;
}

interface ListResponse {
  items: AuthEvent[];
  total: number;
  chain_valid: boolean;
  tip_hash: string | null;
}

const fetcher = (url: string) =>
  fetch(url, { credentials: "same-origin" }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
    return j;
  });

const OUTCOMES = ["all", "success", "denied", "failure"] as const;
const LIMITS = [50, 100, 250, 500, 1000];
const WINDOWS: { label: string; hours: number | null }[] = [
  { label: "last 24h", hours: 24 },
  { label: "last 7d", hours: 24 * 7 },
  { label: "last 30d", hours: 24 * 30 },
  { label: "all time", hours: null },
];

function fmtTs(ms: number): string {
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return String(ms);
  }
}

function OutcomeBadge({ outcome }: { outcome: AuthEvent["outcome"] }) {
  if (outcome === "success") return <Badge tone="success">success</Badge>;
  if (outcome === "denied") return <Badge tone="warn">denied</Badge>;
  return <Badge tone="danger">failure</Badge>;
}

function ActionIcon({ action }: { action: string }) {
  if (action.startsWith("auth.logout")) return <SignOut size={14} weight="duotone" />;
  if (action.startsWith("auth.mfa") || action.startsWith("auth.2fa_")) return <Fingerprint size={14} weight="duotone" />;
  if (action.startsWith("auth.sso")) return <Key size={14} weight="duotone" />;
  return <SignIn size={14} weight="duotone" />;
}

export default function AuthEventsClient() {
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>("all");
  const [limit, setLimit] = useState(250);
  const [windowHours, setWindowHours] = useState<number | null>(24 * 7);
  const [emailFilter, setEmailFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("action_prefix", "auth.");
  if (outcome !== "all") params.set("outcome", outcome);
  if (windowHours !== null) {
    params.set("since_ms", String(Date.now() - windowHours * 3600 * 1000));
  }

  const key = `/api/audit/dashboard?${params.toString()}`;
  const { data, error, isValidating, mutate } = useSWR<ListResponse>(key, fetcher, {
    refreshInterval: 30_000,
  });

  const errMsg = error instanceof Error ? error.message : null;
  const rawItems = data?.items ?? [];
  const items = useMemo(() => {
    const q = emailFilter.trim().toLowerCase();
    if (!q) return rawItems;
    return rawItems.filter(
      (e) =>
        (e.actor_email && e.actor_email.toLowerCase().includes(q)) ||
        (e.target && e.target.toLowerCase().includes(q)) ||
        (e.ip && e.ip.includes(q)),
    );
  }, [rawItems, emailFilter]);
  const chainValid = data?.chain_valid ?? true;

  const counts = useMemo(() => {
    const c = { total: items.length, success: 0, denied: 0, failure: 0, unique_actors: 0 };
    const actors = new Set<string>();
    for (const e of items) {
      c[e.outcome] += 1;
      const a = e.actor_email ?? e.target;
      if (a) actors.add(a);
    }
    c.unique_actors = actors.size;
    return c;
  }, [items]);

  const csvUrl = useMemo(() => {
    const p = new URLSearchParams(params);
    p.set("format", "csv");
    return `/api/audit/dashboard?${p.toString()}`;
  }, [params]);
  const jsonlUrl = useMemo(() => {
    const p = new URLSearchParams(params);
    p.set("format", "jsonl");
    return `/api/audit/dashboard?${p.toString()}`;
  }, [params]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="security"
        title="Authentication events"
        description="Every sign-in, sign-out, magic link, SSO callback, MFA challenge, and OAuth flow. Append-only, hash chained, and exportable to your SIEM."
        actions={
          <div className="flex items-center gap-2">
            {chainValid ? (
              <Badge tone="success">
                <ShieldCheck size={12} weight="duotone" /> chain ok
              </Badge>
            ) : (
              <Badge tone="danger">
                <Warning size={12} weight="duotone" /> chain broken
              </Badge>
            )}
            <Button variant="ghost" onClick={() => mutate()} aria-label="refresh">
              <ArrowsClockwise size={14} weight="duotone" className={isValidating ? "animate-spin" : ""} />
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="events" value={String(counts.total)} />
        <Stat label="success" value={String(counts.success)} />
        <Stat label="denied" value={String(counts.denied)} />
        <Stat label="failure" value={String(counts.failure)} />
      </div>

      <Card>
        <CardHeader
          title="Events"
          hint="Filter by outcome, time window, or email / IP. Drill into a row for full metadata and the hash-chain entry."
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="filter email or ip"
                value={emailFilter}
                onChange={(e) => setEmailFilter(e.target.value)}
                aria-label="filter by email or ip"
                className="w-48"
              />
              <Select
                value={String(windowHours ?? "all")}
                onChange={(e) => {
                  const v = e.target.value;
                  setWindowHours(v === "all" ? null : Number(v));
                }}
                aria-label="time window"
              >
                {WINDOWS.map((w) => (
                  <option key={w.label} value={w.hours === null ? "all" : String(w.hours)}>
                    {w.label}
                  </option>
                ))}
              </Select>
              <Select value={outcome} onChange={(e) => setOutcome(e.target.value as (typeof OUTCOMES)[number])} aria-label="outcome">
                {OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
              <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="row limit">
                {LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <a
                href={csvUrl}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-border)]/40"
              >
                <DownloadSimple size={14} weight="duotone" /> csv
              </a>
              <a
                href={jsonlUrl}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-border)]/40"
              >
                <DownloadSimple size={14} weight="duotone" /> jsonl
              </a>
            </div>
          }
        />
        <div className="p-4">
          {errMsg ? (
            <ErrorBox message={errMsg} />
          ) : !data ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : items.length === 0 ? (
            <Empty
              title="No authentication events in this window"
              hint="Sign in, request a magic link, or trigger an SSO callback to populate this log."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[var(--color-muted)]">
                  <tr>
                    <th className="py-2 pr-2 font-normal">when</th>
                    <th className="py-2 pr-2 font-normal">actor</th>
                    <th className="py-2 pr-2 font-normal">action</th>
                    <th className="py-2 pr-2 font-normal">method</th>
                    <th className="py-2 pr-2 font-normal">outcome</th>
                    <th className="py-2 pr-2 font-normal">ip</th>
                    <th className="py-2 pr-2 font-normal">reason</th>
                    <th className="py-2 pr-2 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => {
                    const md = (e.metadata ?? {}) as Record<string, unknown>;
                    const isOpen = !!expanded[e.id];
                    const method = typeof md.method === "string" ? md.method : "";
                    const reason = typeof md.reason === "string" ? md.reason : "";
                    return (
                      <React.Fragment key={e.id}>
                        <tr
                          className="border-t border-[var(--color-border)] align-top hover:bg-[var(--color-border)]/30"
                        >
                          <td className="py-2 pr-2 font-mono tabular-nums text-[var(--color-muted)]">{fmtTs(e.ts)}</td>
                          <td className="py-2 pr-2 break-all">{e.actor_email ?? e.target ?? "anonymous"}</td>
                          <td className="py-2 pr-2">
                            <span className="inline-flex items-center gap-1">
                              <ActionIcon action={e.action} />
                              <span className="font-mono">{e.action.replace(/^auth\./, "")}</span>
                            </span>
                          </td>
                          <td className="py-2 pr-2 font-mono text-[var(--color-muted)]">{method}</td>
                          <td className="py-2 pr-2">
                            <OutcomeBadge outcome={e.outcome} />
                          </td>
                          <td className="py-2 pr-2 font-mono text-[var(--color-muted)]">{e.ip ?? ""}</td>
                          <td className="py-2 pr-2 font-mono text-[var(--color-muted)]">{reason}</td>
                          <td className="py-2 pr-2">
                            <button
                              type="button"
                              onClick={() => setExpanded((s) => ({ ...s, [e.id]: !s[e.id] }))}
                              aria-label={isOpen ? "collapse" : "expand"}
                              className="rounded p-1 hover:bg-[var(--color-border)]/50"
                            >
                              {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
                            </button>
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr className="bg-[var(--color-border)]/20">
                            <td colSpan={8} className="py-2 pr-2">
                              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-[var(--color-muted)]">
{JSON.stringify(
  {
    id: e.id,
    ts: new Date(e.ts).toISOString(),
    user_agent: e.user_agent,
    metadata: e.metadata,
    prev_hash: e.prev_hash,
    hash: e.hash,
  },
  null,
  2,
)}
                              </pre>
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
