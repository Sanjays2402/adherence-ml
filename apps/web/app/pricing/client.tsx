"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import {
  CheckCircle,
  Sparkle,
  ArrowRight,
  CreditCard,
  Receipt,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  ErrorBox,
  Skeleton,
  Badge,
  SectionLabel,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type PlanId = "free" | "pro" | "scale";

interface Plan {
  id: PlanId;
  name: string;
  daily_quota: number;
  price_usd: number;
  features: string[];
  highlight?: boolean;
}

interface PlanResp {
  current: Plan;
  state: { current: PlanId; changed_at: number };
  plans: Plan[];
}

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<PlanResp>;
  });

function fmtPrice(p: number): string {
  return p === 0 ? "Free" : `$${p}`;
}

function fmtQuota(n: number): string {
  return `${n.toLocaleString()} req / day`;
}

export default function PricingClient() {
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR<PlanResp>(
    "/api/plan",
    fetcher,
  );
  const [pending, setPending] = useState<PlanId | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function choose(id: PlanId) {
    setErrMsg(null);
    setPending(id);
    try {
      const res = await fetch("/api/plan/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        redirect_url?: string;
        detail?: string;
      };
      if (!res.ok) {
        setErrMsg(body.detail ?? `Request failed (${res.status})`);
        setPending(null);
        return;
      }
      await mutate();
      router.push(body.redirect_url ?? "/billing");
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : "Network error");
      setPending(null);
    }
  }

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow="Plans"
        title="Pick a plan that fits your throughput"
        description="Quotas are per UTC day against /v1/predict. Switch any time. No contract."
        actions={
          <Link
            href="/billing"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border border-[var(--color-border-strong)] hover:bg-[var(--color-border)]/40"
          >
            <Receipt weight="duotone" size={14} />
            <span>Billing</span>
          </Link>
        }
      />

      <div className="p-4 md:p-6 space-y-4">
        {error ? (
          <ErrorBox message={`Could not load plans: ${(error as Error).message}`} />
        ) : null}
        {errMsg ? <ErrorBox message={errMsg} /> : null}

        {isLoading || !data ? (
          <div className="grid gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-72 w-full" />
            ))}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {data.plans.map((p) => {
              const isCurrent = p.id === data.current.id;
              const isPending = pending === p.id;
              return (
                <Card
                  key={p.id}
                  className={cn(
                    "relative flex flex-col",
                    p.highlight && "ring-1 ring-[var(--color-accent)]/40",
                  )}
                >
                  {p.highlight ? (
                    <div className="absolute -top-2 left-4 inline-flex items-center gap-1 rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-[var(--color-bg)]">
                      <Sparkle weight="fill" size={10} />
                      Most popular
                    </div>
                  ) : null}
                  <div className="p-5 border-b border-[var(--color-border)]">
                    <div className="flex items-baseline justify-between">
                      <SectionLabel>{p.name}</SectionLabel>
                      {isCurrent ? (
                        <Badge tone="accent">Current</Badge>
                      ) : null}
                    </div>
                    <div className="mt-3 flex items-baseline gap-1.5">
                      <span className="text-2xl font-semibold tabular-nums tracking-tight">
                        {fmtPrice(p.price_usd)}
                      </span>
                      {p.price_usd > 0 ? (
                        <span className="text-xs text-[var(--color-muted)]">/ month</span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs font-mono uppercase tracking-wider text-[var(--color-subtle)]">
                      {fmtQuota(p.daily_quota)}
                    </div>
                  </div>
                  <ul className="p-5 space-y-2 text-sm flex-1">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <CheckCircle
                          weight="duotone"
                          size={16}
                          className="mt-0.5 shrink-0 text-[var(--color-accent)]"
                        />
                        <span className="text-[var(--color-muted)]">{f}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="p-5 pt-0">
                    <button
                      type="button"
                      onClick={() => choose(p.id)}
                      disabled={isCurrent || pending !== null}
                      aria-label={
                        isCurrent
                          ? `${p.name} is your current plan`
                          : `Switch to ${p.name}`
                      }
                      className={cn(
                        "w-full inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed",
                        isCurrent
                          ? "border border-[var(--color-border)] text-[var(--color-muted)]"
                          : p.highlight
                            ? "bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90 disabled:opacity-50"
                            : "bg-[var(--color-fg)] text-[var(--color-bg)] hover:bg-white disabled:opacity-50",
                      )}
                    >
                      {isCurrent ? (
                        <span>You are on this plan</span>
                      ) : isPending ? (
                        <span>Processing...</span>
                      ) : (
                        <>
                          <CreditCard weight="duotone" size={14} />
                          <span>
                            {p.price_usd === 0 ? "Switch to Free" : `Choose ${p.name}`}
                          </span>
                          <ArrowRight weight="duotone" size={14} />
                        </>
                      )}
                    </button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        <Card>
          <CardHeader
            title="What about Stripe?"
            hint="This build does self-serve plan changes without a card"
          />
          <div className="p-5 text-sm text-[var(--color-muted)] leading-relaxed">
            Plan changes are recorded server side and take effect immediately
            against your quota and the /v1/predict endpoint. To wire real
            payments, replace the body of <code className="px-1 rounded bg-[var(--color-border)]/40 font-mono text-xs">app/api/plan/checkout</code>{" "}
            with a Stripe Checkout Session and apply the plan inside a
            checkout.session.completed webhook. The /pricing and /billing UI
            stay the same.
          </div>
        </Card>
      </div>
    </div>
  );
}
