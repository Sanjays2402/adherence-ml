"use client";

import useSWR from "swr";
import { useMemo, useState } from "react";
import {
  ArrowsClockwise,
  ShieldCheck,
  Warning,
  DownloadSimple,
  CaretRight,
  CaretDown,
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
} from "@/components/ui/primitives";

interface AuditEntry {
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
  items: AuditEntry[];
  total: number;
  chain_valid: boolean;
  tip_hash: string | null;
}

const fetcher = (url: string) =>
  fetch(url, { credentials: "same-origin" }).then(async (r) => {
    const j = await r.json();
    if (!r.ok)
      throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
    return j;
  });

const OUTCOMES = ["all", "success", "denied", "failure"] as const;
const LIMITS = [50, 100, 250, 500];

function fmtTs(ms: number): string {
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return String(ms);
  }
}

function OutcomeBadge({ outcome }: { outcome: AuditEntry["outcome"] }) {
  if (outcome === "success") return <Badge tone="success">success</Badge>;
  if (outcome === "denied") return <Badge tone="warn">denied</Badge>;
  return <Badge tone="danger">failure</Badge>;
}

export default function DashboardAuditPanel() {
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>("all");
  const [limit, setLimit] = useState(100);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (outcome !== "all") params.set("outcome", outcome);

  const key = `/api/audit/dashboard?${params.toString()}`;
  const { data, error, isValidating, mutate } = useSWR<ListResponse>(key, fetcher, {
    refreshInterval: 30_000,
  });

  const errMsg = error instanceof Error ? error.message : null;
  const items = data?.items ?? [];
  const chainValid = data?.chain_valid ?? true;

  const downloadUrl = useMemo(() => {
    const p = new URLSearchParams(params);
    p.set("format", "jsonl");
    return `/api/audit/dashboard?${p.toString()}`;
  }, [params]);

  return (
    <Card>
      <CardHeader
        title="Dashboard audit"
        hint="Mutations made from the dashboard: settings changes, exports, wipes. Hash chained and append only."
        right={
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
            <Select
              value={outcome}
              onChange={(e) =>
                setOutcome(e.target.value as (typeof OUTCOMES)[number])
              }
              aria-label="filter outcome"
            >
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
            <Select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              aria-label="row limit"
            >
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n} rows
                </option>
              ))}
            </Select>
            <a
              href={downloadUrl}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-border)]/40"
            >
              <DownloadSimple size={14} weight="duotone" /> export
            </a>
            <Button
              variant="ghost"
              onClick={() => mutate()}
              aria-label="refresh dashboard audit"
            >
              <ArrowsClockwise
                size={14}
                weight="duotone"
                className={isValidating ? "animate-spin" : ""}
              />
            </Button>
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
        </div>
      ) : items.length === 0 ? (
        <Empty
          title="No audit entries yet"
          hint="Settings changes, exports, and wipes will appear here as they happen."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[var(--color-muted)]">
              <tr>
                <th className="py-2 pr-2 font-normal">when</th>
                <th className="py-2 pr-2 font-normal">actor</th>
                <th className="py-2 pr-2 font-normal">action</th>
                <th className="py-2 pr-2 font-normal">target</th>
                <th className="py-2 pr-2 font-normal">outcome</th>
                <th className="py-2 pr-2 font-normal">ip</th>
                <th className="py-2 pr-2 font-normal" />
              </tr>
            </thead>
            <tbody>
              {items.flatMap((e) => {
                const open = !!expanded[e.id];
                const Caret = open ? CaretDown : CaretRight;
                const rows = [
                  <tr key={e.id} className="border-t border-[var(--color-border)]">
                    <td className="py-2 pr-2 tabular-nums">{fmtTs(e.ts)}</td>
                    <td className="py-2 pr-2">
                      {e.actor_email ?? (
                        <span className="text-[var(--color-muted)]">unauthenticated</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 font-mono">{e.action}</td>
                    <td className="py-2 pr-2 text-[var(--color-muted)]">
                      {e.target ?? "-"}
                    </td>
                    <td className="py-2 pr-2">
                      <OutcomeBadge outcome={e.outcome} />
                    </td>
                    <td className="py-2 pr-2 font-mono text-[var(--color-muted)]">
                      {e.ip ?? "-"}
                    </td>
                    <td className="py-2 pr-2 text-right">
                      <button
                        type="button"
                        aria-label="toggle details"
                        onClick={() =>
                          setExpanded((m) => ({ ...m, [e.id]: !m[e.id] }))
                        }
                        className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-border)]/40"
                      >
                        <Caret size={14} weight="bold" />
                      </button>
                    </td>
                  </tr>,
                ];
                if (open)
                  rows.push(
                    <tr
                      key={`${e.id}-detail`}
                      className="border-t border-[var(--color-border)] bg-[var(--color-surface)]"
                    >
                      <td colSpan={7} className="px-2 py-3">
                        <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                          <div>
                            <dt className="text-[var(--color-muted)]">id</dt>
                            <dd className="font-mono">{e.id}</dd>
                          </div>
                          <div>
                            <dt className="text-[var(--color-muted)]">hash</dt>
                            <dd className="break-all font-mono text-[var(--color-muted)]">
                              {e.hash.slice(0, 32)}…
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[var(--color-muted)]">user agent</dt>
                            <dd className="break-all">{e.user_agent ?? "-"}</dd>
                          </div>
                          <div>
                            <dt className="text-[var(--color-muted)]">prev_hash</dt>
                            <dd className="break-all font-mono text-[var(--color-muted)]">
                              {e.prev_hash.slice(0, 32)}…
                            </dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="text-[var(--color-muted)]">metadata</dt>
                            <dd>
                              <pre className="mt-1 overflow-x-auto rounded bg-[var(--color-bg)] p-2 font-mono text-[11px]">
                                {JSON.stringify(e.metadata ?? {}, null, 2)}
                              </pre>
                            </dd>
                          </div>
                        </dl>
                      </td>
                    </tr>,
                  );
                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </Card>
  );
}
