"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import {
  Receipt,
  ArrowsClockwise,
  CheckCircle,
  Sparkle,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Stat,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
  SectionLabel,
} from "@/components/ui/primitives";

type PlanId = "free" | "pro" | "scale";

interface Plan {
  id: PlanId;
  name: string;
  daily_quota: number;
  price_usd: number;
  features: string[];
}

interface PlanChange {
  ts: number;
  from: PlanId;
  to: PlanId;
  reason: string;
}

interface PlanResp {
  current: Plan;
  state: { current: PlanId; changed_at: number; history: PlanChange[] };
}

interface UsageResp {
  quota: number;
  used_today: number;
  remaining_today: number;
  pct_today: number;
  used_30d: number;
}

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

function fmtTime(ms: number): string {
  if (!ms) return "never";
  const d = new Date(ms);
  return d.toLocaleString();
}

function fmtPrice(p: number): string {
  return p === 0 ? "Free" : `$${p} / mo`;
}

export default function BillingClient() {
  const sp = useSearchParams();
  const sessionFromCheckout = sp.get("session");

  const { data: plan, error: planErr, isLoading: planLoading } = useSWR<PlanResp>(
    "/api/plan",
    fetcher,
    { refreshInterval: 0 },
  );
  const { data: usage, error: usageErr, isLoading: usageLoading } = useSWR<UsageResp>(
    "/api/usage",
    fetcher,
    { refreshInterval: 30_000 },
  );

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Billing"
        title="Current plan and usage"
        description="Plan changes apply immediately to your /v1/predict quota."
        actions={
          <Link
            href="/pricing"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm bg-[var(--color-fg)] text-[var(--color-bg)] hover:bg-white"
          >
            <ArrowsClockwise weight="duotone" size={14} />
            <span>Change plan</span>
          </Link>
        }
      />

      <div className="p-4 md:p-6 space-y-4">
        {sessionFromCheckout ? (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-4 py-3 text-sm">
            <CheckCircle
              weight="duotone"
              size={18}
              className="mt-0.5 text-[var(--color-accent)] shrink-0"
            />
            <div>
              <div className="font-medium">Plan updated</div>
              <div className="text-xs text-[var(--color-muted)] mt-0.5">
                Checkout session{" "}
                <span className="font-mono">{sessionFromCheckout}</span>{" "}
                applied. Your new quota is active.
              </div>
            </div>
          </div>
        ) : null}

        {planErr ? (
          <ErrorBox message={`Could not load plan: ${(planErr as Error).message}`} />
        ) : null}
        {usageErr ? (
          <ErrorBox message={`Could not load usage: ${(usageErr as Error).message}`} />
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="md:col-span-2">
            <CardHeader title="Plan" hint="What you are paying for today" />
            <div className="p-5">
              {planLoading || !plan ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-2 min-w-0">
                    <div className="flex items-center gap-2">
                      <SectionLabel>{plan.current.name}</SectionLabel>
                      <Badge tone="accent">Active</Badge>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-semibold tabular-nums">
                        {fmtPrice(plan.current.price_usd)}
                      </span>
                      <span className="text-xs text-[var(--color-muted)]">
                        {plan.current.daily_quota.toLocaleString()} req / day
                      </span>
                    </div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
                      Updated {fmtTime(plan.state.changed_at)}
                    </div>
                  </div>
                  <Link
                    href="/pricing"
                    className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm border border-[var(--color-border-strong)] hover:bg-[var(--color-border)]/40 hover:border-[var(--color-accent)]/40"
                  >
                    <Sparkle weight="duotone" size={14} />
                    <span>Compare plans</span>
                  </Link>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Today" hint="Reset at 00:00 UTC" />
            <div className="p-5 space-y-3">
              {usageLoading || !usage ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <>
                  <Stat
                    label="Used"
                    value={`${usage.used_today.toLocaleString()} / ${usage.quota.toLocaleString()}`}
                  />
                  <div className="h-1.5 w-full rounded-full bg-[var(--color-border)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--color-accent)] transition-all"
                      style={{ width: `${Math.min(100, usage.pct_today * 100)}%` }}
                    />
                  </div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
                    {usage.remaining_today.toLocaleString()} remaining
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Plan history"
            hint="Last 50 plan changes for this workspace"
          />
          <div className="p-2 md:p-3">
            {planLoading || !plan ? (
              <Skeleton className="h-24 w-full" />
            ) : plan.state.history.length === 0 ? (
              <Empty
                icon={<Receipt weight="duotone" size={20} />}
                title="No plan changes yet"
                hint="Switch plans on the Pricing page to record a change here."
              />
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {[...plan.state.history].reverse().map((h, i) => (
                  <li
                    key={`${h.ts}-${i}`}
                    className="flex items-center justify-between px-3 py-2.5 text-sm gap-3"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Receipt
                        weight="duotone"
                        size={16}
                        className="text-[var(--color-accent)] shrink-0"
                      />
                      <span className="font-mono text-xs uppercase tracking-wider">
                        {h.from}
                      </span>
                      <span className="text-[var(--color-subtle)]">to</span>
                      <span className="font-mono text-xs uppercase tracking-wider">
                        {h.to}
                      </span>
                      <span className="hidden md:inline text-[11px] text-[var(--color-muted)] truncate">
                        {h.reason}
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-[var(--color-subtle)] shrink-0 tabular-nums">
                      {fmtTime(h.ts)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
