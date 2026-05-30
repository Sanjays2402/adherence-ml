"use client";

import useSWR from "swr";
import { useState } from "react";
import Link from "next/link";
import {
  ArrowsClockwise,
  UsersThree,
  CaretRight,
  Warning,
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
  Select,
} from "@/components/ui/primitives";
import type { CohortRiskResponse, CohortBucket } from "@/lib/types";
import { fmtInt, fmtPct, riskRailClass } from "@/lib/utils";
import { MonoChip, LiveDot } from "@/components/ui/primitives";

const fetcher = (url: string, init?: RequestInit) =>
  fetch(url, init).then(async (r) => {
    const j = await r.json();
    if (!r.ok)
      throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
    return j;
  });

type Initial = CohortRiskResponse | { error: string };

const TOP_OPTIONS = [10, 20, 50, 100];

export default function CohortClient({ initial }: { initial: Initial }) {
  const [topN, setTopN] = useState(20);
  const key = `/api/cohort/risk?top_users=${topN}`;

  const { data, error, isLoading, mutate, isValidating } =
    useSWR<CohortRiskResponse>(
      key,
      (k: string) =>
        fetcher(k, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      {
        fallbackData: "error" in initial ? undefined : initial,
        refreshInterval: 60_000,
      },
    );

  const fatal =
    error?.message ?? ("error" in initial && !data ? initial.error : null);

  return (
    <>
      <PageHeader
        eyebrow="cohort // risk rollups"
        title="Cohort risk"
        description="Population miss probability rolled up by dose class, time-of-day slot, and per user. Click a user to drill into per-dose predictions and the N-day adherence forecast."
        actions={
          <div className="flex items-center gap-2">
            <MonoChip>
              <LiveDot />
              60s poll
            </MonoChip>
            <Select
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value))}
            >
              {TOP_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  top {n}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              onClick={() => mutate()}
              disabled={isValidating}
            >
              <ArrowsClockwise weight="duotone" size={14} />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {fatal ? <ErrorBox message={fatal} /> : null}

        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          {isLoading && !data ? (
            <>
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </>
          ) : data ? (
            <>
              <Stat
                label="Total doses"
                value={fmtInt(data.total_doses)}
                sub={`${data.by_dose_class.length} dose classes`}
              />
              <Stat
                label="Mean p(miss)"
                value={fmtPct(data.overall_mean_risk)}
                sub="cohort weighted"
              />
              <Stat
                label="High risk users"
                value={fmtInt(
                  data.top_users.filter((u) => u.mean_miss_probability >= 0.7)
                    .length,
                )}
                sub="p ≥ 0.7"
              />
              <Stat
                label="Model"
                value={
                  <span className="text-sm font-mono truncate block">
                    {data.model_name}
                  </span>
                }
                sub={`v${data.model_version}`}
              />
            </>
          ) : null}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <BucketCard
            title="By dose class"
            hint="Mean miss probability per medication class."
            buckets={data?.by_dose_class}
            loading={isLoading && !data}
          />
          <BucketCard
            title="By time of day"
            hint="Risk varies with schedule slot."
            buckets={data?.by_time_bucket}
            loading={isLoading && !data}
          />
        </div>

        <Card>
          <CardHeader
            title="Top users by risk"
            hint="Sorted by mean miss probability. Click to open a per-user view."
            right={
              data?.top_users.length ? (
                <Badge tone="neutral">{data.top_users.length}</Badge>
              ) : null
            }
          />
          {isLoading && !data ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : data && data.top_users.length ? (
            <div className="divide-y divide-[var(--color-border)]">
              <div className="grid grid-cols-12 gap-2 px-4 py-2 text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
                <div className="col-span-5">user</div>
                <div className="col-span-2 text-right">doses</div>
                <div className="col-span-2 text-right">mean risk</div>
                <div className="col-span-2 text-right">% high</div>
                <div className="col-span-1" />
              </div>
              {data.top_users.map((u) => (
                <UserRow key={u.key} bucket={u} />
              ))}
            </div>
          ) : (
            <Empty
              icon={<UsersThree weight="duotone" size={20} />}
              title="No users"
              hint="The cohort sample produced no per-user rollup yet."
            />
          )}
        </Card>
      </div>
    </>
  );
}

function BucketCard({
  title,
  hint,
  buckets,
  loading,
}: {
  title: string;
  hint?: string;
  buckets: CohortBucket[] | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader title={title} hint={hint} />
      {loading ? (
        <div className="p-4 space-y-2">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : !buckets || buckets.length === 0 ? (
        <Empty
          icon={<Warning weight="duotone" size={20} />}
          title="No buckets"
          hint="No grouped rows for this slice."
        />
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {buckets.map((b) => (
            <BucketRow key={b.key} bucket={b} />
          ))}
        </div>
      )}
    </Card>
  );
}

function BucketRow({ bucket: b }: { bucket: CohortBucket }) {
  const pct = Math.min(1, b.mean_miss_probability);
  const tone =
    b.mean_miss_probability >= 0.7
      ? "var(--color-high)"
      : b.mean_miss_probability >= 0.4
        ? "var(--color-mid)"
        : "var(--color-low)";
  return (
    <div className={`pl-4 pr-4 py-2.5 ${riskRailClass(b.mean_miss_probability)}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium truncate">{b.key}</div>
        <div className="flex items-center gap-3 shrink-0 text-xs tabular-nums">
          <span className="text-[var(--color-muted)]">
            {fmtInt(b.n_doses)} doses
          </span>
          <span className="font-medium">{fmtPct(b.mean_miss_probability)}</span>
        </div>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct * 100}%`, background: tone }}
        />
      </div>
    </div>
  );
}

function UserRow({ bucket: u }: { bucket: CohortBucket }) {
  const tone =
    u.mean_miss_probability >= 0.7
      ? "danger"
      : u.mean_miss_probability >= 0.4
        ? "warn"
        : "success";
  return (
    <Link
      href={`/cohort/users/${encodeURIComponent(u.key)}`}
      className={`grid grid-cols-12 gap-2 pl-4 pr-4 py-2.5 items-center hover:bg-[var(--color-border)]/30 transition-colors ${riskRailClass(u.mean_miss_probability)}`}
    >
      <div className="col-span-5 min-w-0">
        <div className="text-[13px] font-mono truncate">{u.key}</div>
      </div>
      <div className="col-span-2 text-right text-xs tabular-nums text-[var(--color-muted)]">
        {fmtInt(u.n_doses)}
      </div>
      <div className="col-span-2 text-right text-sm tabular-nums">
        <Badge tone={tone}>{fmtPct(u.mean_miss_probability)}</Badge>
      </div>
      <div className="col-span-2 text-right text-xs tabular-nums text-[var(--color-muted)]">
        {fmtPct(u.pct_high_risk)}
      </div>
      <div className="col-span-1 text-right text-[var(--color-muted)]">
        <CaretRight weight="duotone" size={14} />
      </div>
    </Link>
  );
}
