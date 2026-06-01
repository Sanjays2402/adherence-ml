"use client";

import React, { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowsClockwise,
  ShieldWarning,
  DownloadSimple,
  CaretRight,
  CaretDown,
  UserCircle,
  Buildings,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Stat,
} from "@/components/ui/primitives";

interface BgEvent {
  id: number;
  created_at: string;
  caller: string;
  caller_role: string;
  source_tenant: string;
  target_tenant: string;
  route: string;
  method: string;
  justification: string;
  client_ip: string | null;
  request_id: string | null;
}

interface ListResp {
  n: number;
  total: number;
  events: BgEvent[];
}

interface StatsRow {
  source_tenant: string;
  caller_role: string;
  n: number;
}

interface StatsResp {
  target_tenant: string;
  n_total: number;
  by_source: StatsRow[];
}

async function fetcher<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin" });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw
  }
  if (!r.ok) {
    const msg =
      body && typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body as T;
}

const LIMITS = [50, 100, 250, 500, 1000];

function fmtTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return iso;
  }
}

function MethodBadge({ method }: { method: string }) {
  const tone =
    method === "GET"
      ? "neutral"
      : method === "DELETE"
        ? "danger"
        : method === "POST" || method === "PUT" || method === "PATCH"
          ? "warn"
          : "neutral";
  return <Badge tone={tone as "neutral" | "warn" | "danger"}>{method}</Badge>;
}

export default function BreakGlassClient() {
  const [limit, setLimit] = useState(100);
  const [tenant, setTenant] = useState("");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (tenant.trim()) params.set("tenant", tenant.trim());

  const listKey = `/api/break-glass?${params.toString()}`;
  const statsKey = `/api/break-glass/stats${
    tenant.trim() ? `?tenant=${encodeURIComponent(tenant.trim())}` : ""
  }`;

  const { data, error, isValidating, mutate } = useSWR<ListResp>(
    listKey,
    fetcher,
    { refreshInterval: 30_000 },
  );
  const { data: stats } = useSWR<StatsResp>(statsKey, fetcher, {
    refreshInterval: 30_000,
  });

  const errMsg = error instanceof Error ? error.message : null;
  const rawItems = data?.events ?? [];
  const items = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rawItems;
    return rawItems.filter(
      (e) =>
        e.caller.toLowerCase().includes(q) ||
        e.source_tenant.toLowerCase().includes(q) ||
        e.route.toLowerCase().includes(q) ||
        e.justification.toLowerCase().includes(q) ||
        (e.client_ip ?? "").includes(q) ||
        (e.request_id ?? "").toLowerCase().includes(q),
    );
  }, [rawItems, filter]);

  const csvUrl = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", String(Math.max(limit, 1000)));
    if (tenant.trim()) p.set("tenant", tenant.trim());
    return `/api/break-glass/export.csv?${p.toString()}`;
  }, [limit, tenant]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <div className="text-xs">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft size={12} weight="duotone" /> back to settings
        </Link>
      </div>

      <PageHeader
        eyebrow="security"
        title="Break-glass access"
        description="Every time a vendor admin reaches into this workspace from outside it, the access is logged here with the caller, the justification they had to type, and the request ID. Append-only and exportable."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                mutate();
              }}
              aria-label="refresh"
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="events shown" value={String(items.length)} />
        <Stat label="total recorded" value={String(data?.total ?? "-")} />
        <Stat
          label="unique callers"
          value={String(
            new Set(items.map((e) => e.caller)).size || 0,
          )}
        />
        <Stat
          label="source tenants"
          value={String(stats?.by_source.length ?? 0)}
        />
      </div>

      {stats && stats.by_source.length > 0 ? (
        <Card>
          <CardHeader
            title="By source tenant"
            hint="Where the cross-tenant access came from. Use this to spot a single source tenant or role hitting your workspace repeatedly."
          />
          <div className="px-4 pb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[var(--color-muted)]">
                  <tr>
                    <th className="py-2 pr-2 font-normal">source tenant</th>
                    <th className="py-2 pr-2 font-normal">caller role</th>
                    <th className="py-2 pr-2 font-normal">events</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_source.map((r) => (
                    <tr
                      key={`${r.source_tenant}:${r.caller_role}`}
                      className="border-t border-[var(--color-border)]"
                    >
                      <td className="py-2 pr-2 font-mono">
                        <span className="inline-flex items-center gap-1">
                          <Buildings size={12} weight="duotone" />
                          {r.source_tenant}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        <Badge tone="neutral">{r.caller_role}</Badge>
                      </td>
                      <td className="py-2 pr-2 font-mono tabular-nums">
                        {r.n}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Events"
          hint="Filter by caller, source tenant, route, IP, request ID, or any word in the justification."
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="filter events"
                className="w-44"
              />
              <Input
                placeholder="tenant override"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                aria-label="tenant override"
                className="w-40"
              />
              <Select
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                aria-label="row limit"
              >
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
              title="No break-glass events"
              hint="When a vendor admin reaches into this workspace from outside it, the access shows up here with the justification they typed."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[var(--color-muted)]">
                  <tr>
                    <th className="py-2 pr-2 font-normal">when</th>
                    <th className="py-2 pr-2 font-normal">caller</th>
                    <th className="py-2 pr-2 font-normal">role</th>
                    <th className="py-2 pr-2 font-normal">source</th>
                    <th className="py-2 pr-2 font-normal">method</th>
                    <th className="py-2 pr-2 font-normal">route</th>
                    <th className="py-2 pr-2 font-normal">ip</th>
                    <th className="py-2 pr-2 font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => {
                    const isOpen = !!expanded[e.id];
                    return (
                      <React.Fragment key={e.id}>
                        <tr className="border-t border-[var(--color-border)] align-top hover:bg-[var(--color-border)]/30">
                          <td className="py-2 pr-2 font-mono tabular-nums text-[var(--color-muted)]">
                            {fmtTs(e.created_at)}
                          </td>
                          <td className="py-2 pr-2 break-all">
                            <span className="inline-flex items-center gap-1">
                              <UserCircle size={12} weight="duotone" />
                              {e.caller}
                            </span>
                          </td>
                          <td className="py-2 pr-2">
                            <Badge tone="warn">{e.caller_role}</Badge>
                          </td>
                          <td className="py-2 pr-2 font-mono break-all">
                            {e.source_tenant}
                          </td>
                          <td className="py-2 pr-2">
                            <MethodBadge method={e.method} />
                          </td>
                          <td className="py-2 pr-2 font-mono break-all text-[var(--color-muted)]">
                            {e.route}
                          </td>
                          <td className="py-2 pr-2 font-mono text-[var(--color-muted)]">
                            {e.client_ip ?? ""}
                          </td>
                          <td className="py-2 pr-2">
                            <button
                              type="button"
                              onClick={() =>
                                setExpanded((s) => ({ ...s, [e.id]: !s[e.id] }))
                              }
                              aria-label={isOpen ? "collapse" : "expand"}
                              aria-expanded={isOpen}
                              className="rounded p-1 hover:bg-[var(--color-border)]/50"
                            >
                              {isOpen ? (
                                <CaretDown size={12} />
                              ) : (
                                <CaretRight size={12} />
                              )}
                            </button>
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr className="bg-[var(--color-border)]/20">
                            <td colSpan={8} className="px-2 py-3">
                              <div className="space-y-2 text-[11px]">
                                <div className="flex items-start gap-2">
                                  <ShieldWarning
                                    size={14}
                                    weight="duotone"
                                    className="mt-0.5 shrink-0 text-[var(--color-muted)]"
                                  />
                                  <div className="min-w-0">
                                    <div className="text-[var(--color-muted)]">
                                      justification
                                    </div>
                                    <div className="whitespace-pre-wrap break-words">
                                      {e.justification}
                                    </div>
                                  </div>
                                </div>
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  <div>
                                    <div className="text-[var(--color-muted)]">
                                      request id
                                    </div>
                                    <div className="font-mono break-all">
                                      {e.request_id ?? ""}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[var(--color-muted)]">
                                      target tenant
                                    </div>
                                    <div className="font-mono break-all">
                                      {e.target_tenant}
                                    </div>
                                  </div>
                                </div>
                              </div>
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
