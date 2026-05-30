"use client";

import useSWR from "swr";
import { useState } from "react";
import {
  ArrowsClockwise,
  ShieldCheck,
  Warning,
  Pulse,
  ListChecks,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Stat,
  Empty,
  ErrorBox,
  Skeleton,
  Button,
  Badge,
  Input,
  Select,
} from "@/components/ui/primitives";
import type { AuditListResponse, AuditStatsResponse } from "@/lib/types";
import { fmtInt, fmtNum, fmtPct, fmtTime } from "@/lib/utils";

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    const j = await r.json();
    if (!r.ok)
      throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
    return j;
  });

type InitialStats = AuditStatsResponse | { error: string };
type InitialList = AuditListResponse | { error: string };

const WINDOWS = [
  { v: 1, label: "1h" },
  { v: 6, label: "6h" },
  { v: 24, label: "24h" },
  { v: 168, label: "7d" },
  { v: 720, label: "30d" },
];

const LIMITS = [50, 100, 250, 500];

export default function AuditClient({
  initialStats,
  initialList,
}: {
  initialStats: InitialStats;
  initialList: InitialList;
}) {
  const [windowHours, setWindowHours] = useState(24);
  const [limit, setLimit] = useState(100);
  const [userId, setUserId] = useState("");
  const [route, setRoute] = useState("");
  const [model, setModel] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [appliedFilters, setAppliedFilters] = useState({
    userId: "",
    route: "",
    model: "",
    onlyErrors: false,
    limit: 100,
  });

  const statsKey = `/api/audit/stats?window_hours=${windowHours}`;
  const stats = useSWR<AuditStatsResponse>(statsKey, fetcher, {
    fallbackData: "error" in initialStats ? undefined : initialStats,
    refreshInterval: 30_000,
  });

  const listParams = new URLSearchParams();
  listParams.set("limit", String(appliedFilters.limit));
  if (appliedFilters.userId) listParams.set("user_id", appliedFilters.userId);
  if (appliedFilters.route) listParams.set("route", appliedFilters.route);
  if (appliedFilters.model) listParams.set("model_name", appliedFilters.model);
  if (appliedFilters.onlyErrors) listParams.set("only_errors", "true");
  const listKey = `/api/audit/list?${listParams.toString()}`;

  const list = useSWR<AuditListResponse>(listKey, fetcher, {
    fallbackData:
      "error" in initialList || appliedFilters.userId || appliedFilters.route ||
      appliedFilters.model || appliedFilters.onlyErrors ||
      appliedFilters.limit !== 100
        ? undefined
        : initialList,
    refreshInterval: 30_000,
  });

  const statsErr =
    stats.error?.message ??
    ("error" in initialStats && !stats.data ? initialStats.error : null);
  const listErr =
    list.error?.message ??
    ("error" in initialList && !list.data ? initialList.error : null);

  const onApply = (e: React.FormEvent) => {
    e.preventDefault();
    setAppliedFilters({
      userId: userId.trim(),
      route: route.trim(),
      model: model.trim(),
      onlyErrors,
      limit,
    });
  };
  const onReset = () => {
    setUserId("");
    setRoute("");
    setModel("");
    setOnlyErrors(false);
    setLimit(100);
    setAppliedFilters({
      userId: "",
      route: "",
      model: "",
      onlyErrors: false,
      limit: 100,
    });
  };

  const refreshAll = () => {
    stats.mutate();
    list.mutate();
  };

  const s = stats.data;
  const refreshing = stats.isValidating || list.isValidating;

  return (
    <>
      <PageHeader
        title="Audit"
        description="Live prediction audit log. Filter by user, route, model, or errors. Counters refresh every 30 seconds."
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={windowHours}
              onChange={(e) => setWindowHours(Number(e.target.value))}
            >
              {WINDOWS.map((w) => (
                <option key={w.v} value={w.v}>
                  last {w.label}
                </option>
              ))}
            </Select>
            <Button variant="ghost" onClick={refreshAll} disabled={refreshing}>
              <ArrowsClockwise weight="duotone" size={14} />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {statsErr ? <ErrorBox message={statsErr} /> : null}

        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          {stats.isLoading && !s ? (
            <>
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </>
          ) : s ? (
            <>
              <Stat
                label="Calls"
                value={fmtInt(s.n_calls)}
                sub={`window ${s.window_hours}h`}
              />
              <Stat
                label="Error rate"
                value={fmtPct(s.error_rate, 2)}
                sub={`${fmtInt(s.n_errors)} errors`}
              />
              <Stat
                label="p50 / p95 latency"
                value={
                  <span className="text-sm font-mono">
                    {fmtNum(s.p50_latency_ms, 1)} / {fmtNum(s.p95_latency_ms, 1)} ms
                  </span>
                }
                sub="server side"
              />
              <Stat
                label="High risk calls"
                value={fmtInt(s.high_risk_calls)}
                sub={`mean p ${fmtPct(s.mean_miss_prob)}`}
              />
            </>
          ) : null}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="By model"
              hint="Calls bucketed by the model that served the request."
              right={
                s ? (
                  <Badge tone="neutral">{Object.keys(s.by_model).length}</Badge>
                ) : null
              }
            />
            {stats.isLoading && !s ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-6" />
                <Skeleton className="h-6" />
                <Skeleton className="h-6" />
              </div>
            ) : s && Object.keys(s.by_model).length > 0 ? (
              <BreakdownTable data={s.by_model} total={s.n_calls} />
            ) : (
              <Empty
                icon={<Pulse weight="duotone" size={20} />}
                title="No traffic"
                hint="No predictions recorded in this window."
              />
            )}
          </Card>

          <Card>
            <CardHeader
              title="By route"
              hint="Which endpoints are taking traffic."
              right={
                s ? (
                  <Badge tone="neutral">{Object.keys(s.by_route).length}</Badge>
                ) : null
              }
            />
            {stats.isLoading && !s ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-6" />
                <Skeleton className="h-6" />
                <Skeleton className="h-6" />
              </div>
            ) : s && Object.keys(s.by_route).length > 0 ? (
              <BreakdownTable data={s.by_route} total={s.n_calls} />
            ) : (
              <Empty
                icon={<ListChecks weight="duotone" size={20} />}
                title="No routes hit"
                hint="No predictions recorded in this window."
              />
            )}
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Recent calls"
            hint="Apply filters to narrow the audit log."
            right={
              list.data ? (
                <Badge tone={appliedFilters.onlyErrors ? "danger" : "neutral"}>
                  {list.data.n} shown
                </Badge>
              ) : null
            }
          />

          <form
            onSubmit={onApply}
            className="grid gap-3 px-4 py-3 border-b border-[var(--color-border)] md:grid-cols-6"
          >
            <Input
              placeholder="user id"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
            <Input
              placeholder="route (eg /v1/predict)"
              value={route}
              onChange={(e) => setRoute(e.target.value)}
            />
            <Input
              placeholder="model name"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <Select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  limit {n}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={onlyErrors}
                onChange={(e) => setOnlyErrors(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              only errors
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="primary">
                Apply
              </Button>
              <Button type="button" variant="ghost" onClick={onReset}>
                Reset
              </Button>
            </div>
          </form>

          {listErr ? (
            <div className="p-4">
              <ErrorBox message={listErr} />
            </div>
          ) : list.isLoading && !list.data ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : list.data && list.data.items.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="text-left font-normal px-4 py-2">when</th>
                    <th className="text-left font-normal px-4 py-2">route</th>
                    <th className="text-left font-normal px-4 py-2">user</th>
                    <th className="text-left font-normal px-4 py-2">model</th>
                    <th className="text-right font-normal px-4 py-2">doses</th>
                    <th className="text-right font-normal px-4 py-2">mean p</th>
                    <th className="text-right font-normal px-4 py-2">latency</th>
                    <th className="text-left font-normal px-4 py-2">status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-[var(--color-border)]/60 hover:bg-[var(--color-border)]/20"
                    >
                      <td className="px-4 py-2 whitespace-nowrap text-[var(--color-muted)]">
                        {fmtTime(r.created_at)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{r.route}</td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {r.user_id}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs truncate max-w-[12rem]">
                        {r.model_name}
                        <span className="text-[var(--color-muted)]">
                          {" "}
                          {r.model_version}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {fmtInt(r.n_doses)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {fmtPct(r.mean_miss_prob)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {fmtNum(r.latency_ms, 1)} ms
                      </td>
                      <td className="px-4 py-2">
                        {r.ok ? (
                          <Badge tone="success">
                            <ShieldCheck weight="duotone" size={12} />
                            ok
                          </Badge>
                        ) : (
                          <Badge tone="danger">
                            <Warning weight="duotone" size={12} />
                            {r.error ? r.error.slice(0, 32) : "error"}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              icon={<ListChecks weight="duotone" size={20} />}
              title="No audit rows"
              hint="No predictions match these filters. Try widening the window or clearing filters."
            />
          )}
        </Card>
      </div>
    </>
  );
}

function BreakdownTable({
  data,
  total,
}: {
  data: Record<string, number>;
  total: number;
}) {
  const rows = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div className="divide-y divide-[var(--color-border)]/60">
      {rows.map(([k, v]) => {
        const pct = total > 0 ? v / total : 0;
        return (
          <div
            key={k}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-2 text-sm"
          >
            <span className="font-mono text-xs truncate" title={k}>
              {k}
            </span>
            <span className="tabular-nums text-[var(--color-muted)]">
              {fmtInt(v)}
            </span>
            <span className="tabular-nums w-12 text-right">
              {fmtPct(pct, 1)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
