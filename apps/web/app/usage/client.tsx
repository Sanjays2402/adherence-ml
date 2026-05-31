"use client";

import useSWR from "swr";
import Link from "next/link";
import { Gauge, ChartBar, Rocket, Key, Warning } from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Stat,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
  MonoChip,
  SectionLabel,
} from "@/components/ui/primitives";

type DayBucket = { date: string; total: number };
type KeyUsage = { key_id: string; count: number; name: string; prefix: string };
type Resp = {
  quota: number;
  used_today: number;
  remaining_today: number;
  pct_today: number;
  used_30d: number;
  days: DayBucket[];
  by_key_30d: KeyUsage[];
};

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<Resp>;
  });

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function Sparkline({ days }: { days: DayBucket[] }) {
  const w = 600;
  const h = 96;
  const pad = 4;
  const max = Math.max(1, ...days.map((d) => d.total));
  const bw = (w - pad * 2) / days.length;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-24"
      role="img"
      aria-label="30 day request volume"
    >
      {days.map((d, i) => {
        const bh = (d.total / max) * (h - pad * 2);
        const x = pad + i * bw + 1;
        const y = h - pad - bh;
        return (
          <g key={d.date}>
            <rect
              x={x}
              y={y}
              width={Math.max(1, bw - 2)}
              height={Math.max(d.total > 0 ? 2 : 0, bh)}
              rx={1.5}
              fill="var(--color-accent)"
              opacity={d.total > 0 ? 0.85 : 0.18}
            >
              <title>{`${d.date}: ${d.total} req`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

function QuotaMeter({ used, quota, pct: p }: { used: number; quota: number; pct: number }) {
  const over = used >= quota;
  const near = !over && p >= 0.8;
  const color = over
    ? "var(--color-danger)"
    : near
      ? "var(--color-warn)"
      : "var(--color-accent)";
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums">
          {used.toLocaleString()}
          <span className="text-[var(--color-muted)] text-base"> / {quota.toLocaleString()}</span>
        </span>
        <span className="text-xs font-mono uppercase tracking-wider text-[var(--color-muted)]">
          {pct(p)} used today
        </span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-[var(--color-border)]/40 overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${Math.min(100, p * 100)}%`, background: color }}
        />
      </div>
      {over && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-danger)]">
          <Warning weight="duotone" size={14} />
          <span>Daily quota reached. /v1/predict will return 429 until 00:00 UTC.</span>
        </div>
      )}
      {near && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-warn)]">
          <Warning weight="duotone" size={14} />
          <span>You are close to the free tier limit.</span>
        </div>
      )}
    </div>
  );
}

export default function UsageClient() {
  const { data, error, isLoading } = useSWR<Resp>("/api/usage", fetcher, {
    refreshInterval: 15_000,
  });

  return (
    <div className="px-4 md:px-8 py-6 md:py-8 max-w-5xl mx-auto space-y-6">
      <PageHeader
        eyebrow="Billing"
        title="Usage"
        description="Free tier quota, 30 day request volume, and per-key breakdown for /v1/predict."
      />

      {error && <ErrorBox message={`Could not load usage: ${(error as Error).message}`} />}

      {isLoading && !data && (
        <div className="grid gap-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {data && (
        <>
          <Card>
            <CardHeader
              title="Today"
              hint="Resets daily at 00:00 UTC"
              right={
                data.used_today >= data.quota ? (
                  <Badge tone="danger">over quota</Badge>
                ) : data.pct_today >= 0.8 ? (
                  <Badge tone="warn">near limit</Badge>
                ) : (
                  <Badge tone="success">healthy</Badge>
                )
              }
            />
            <div className="p-4 md:p-5">
              <QuotaMeter used={data.used_today} quota={data.quota} pct={data.pct_today} />
              <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat label="Used today" value={data.used_today.toLocaleString()} />
                <Stat label="Remaining" value={data.remaining_today.toLocaleString()} />
                <Stat label="Daily quota" value={data.quota.toLocaleString()} />
                <Stat label="Last 30 days" value={data.used_30d.toLocaleString()} />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="30 day volume" hint="UTC daily buckets" />
            <div className="p-4 md:p-5 space-y-3">
              {data.used_30d === 0 ? (
                <Empty
                  icon={<ChartBar weight="duotone" size={20} />}
                  title="No requests yet"
                  hint="Issue an API key and POST to /v1/predict to see traffic here."
                />

              ) : (
                <>
                  <Sparkline days={data.days} />
                  <div className="flex justify-between text-[10px] font-mono uppercase tracking-wider text-[var(--color-subtle)]">
                    <span>{data.days[0]?.date}</span>
                    <span>{data.days[data.days.length - 1]?.date}</span>
                  </div>
                </>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="By API key" hint="Last 30 days" />
            <div className="p-4 md:p-5">
              {data.by_key_30d.length === 0 ? (
                <Empty
                  icon={<Key weight="duotone" size={20} />}
                  title="No key activity"
                  hint="Create your first key on the API keys page."
                />
              ) : (
                <ul className="divide-y divide-[var(--color-border)]/50">
                  {data.by_key_30d.map((k) => {
                    const share = data.used_30d > 0 ? k.count / data.used_30d : 0;
                    return (
                      <li
                        key={k.key_id}
                        className="py-2.5 flex items-center gap-3 text-sm"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{k.name}</span>
                            {k.prefix && <MonoChip>{k.prefix}…</MonoChip>}
                          </div>
                          <div className="mt-1 h-1 w-full rounded-full bg-[var(--color-border)]/40 overflow-hidden">
                            <div
                              className="h-full bg-[var(--color-accent)]"
                              style={{ width: `${share * 100}%` }}
                            />
                          </div>
                        </div>
                        <div className="text-right tabular-nums">
                          <div className="font-medium">{k.count.toLocaleString()}</div>
                          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-subtle)]">
                            {pct(share)}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Need more headroom?" hint="Switch plans any time, change applies immediately" />
            <div className="p-4 md:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="space-y-1">
                <SectionLabel>Upgrade your plan</SectionLabel>
                <div className="text-sm text-[var(--color-muted)]">
                  Pro: 25,000 req / day. Scale: 250,000 req / day with priority routing.
                </div>
              </div>
              <div className="flex gap-2">
                <Link
                  href="/pricing"
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm bg-[var(--color-fg)] text-[var(--color-bg)] hover:bg-white transition-colors"
                >
                  Compare plans
                </Link>
                <Link
                  href="/billing"
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border border-[var(--color-border-strong)] text-[var(--color-fg)] hover:bg-[var(--color-border)]/40 hover:border-[var(--color-accent)]/40 transition-colors"
                >
                  Billing
                </Link>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
