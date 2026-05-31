"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from "recharts";
import {
  ArrowsClockwise,
  Spinner,
  WarningCircle,
  CheckCircle,
  Trophy,
  ArrowRight,
  Lightning,
  Bell,
  User,
  ChartBar,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  ErrorBox,
  Empty,
  Badge,
  Skeleton,
} from "@/components/ui/primitives";
import { PERSONAS, type Persona } from "../demo/personas";
import type { PredictResponse, DosePrediction, ReasonCode } from "@/lib/types";
import { fmtPct, cn } from "@/lib/utils";

interface Scored {
  persona: Persona;
  result: PredictResponse | null;
  error: string | null;
  latency_ms: number | null;
  loading: boolean;
}

function buildPayload(p: Persona, anchor: Date) {
  const anchor_ms = anchor.getTime();
  return {
    user_id: p.user_id,
    top_k_reasons: 4,
    schedule: p.schedule.map((s) => ({
      dose_id: s.dose_id,
      scheduled_at: new Date(anchor_ms + s.hours_from_now * 3600_000).toISOString(),
      dose_class: s.dose_class,
      dose_strength_mg: s.dose_strength_mg,
    })),
    history: p.history.map((h) => {
      const scheduled = new Date(anchor_ms + h.hours_from_now * 3600_000);
      const taken_at =
        (h.status === "taken" || h.status === "late") && h.taken_offset_min != null
          ? new Date(scheduled.getTime() + h.taken_offset_min * 60_000).toISOString()
          : null;
      return {
        user_id: p.user_id,
        dose_id: h.dose_id,
        scheduled_at: scheduled.toISOString(),
        taken_at,
        status: h.status,
        dose_class: h.dose_class,
        dose_strength_mg: h.dose_strength_mg,
      };
    }),
  };
}

async function scoreOne(p: Persona, anchor: Date): Promise<{ result: PredictResponse; latency_ms: number }> {
  const body = buildPayload(p, anchor);
  const t0 = performance.now();
  const res = await fetch("/api/proxy/v1/predict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(typeof json?.detail === "string" ? json.detail : `Request failed (${res.status})`);
  }
  return { result: json as PredictResponse, latency_ms: Math.round(performance.now() - t0) };
}

function avgMiss(r: PredictResponse): number {
  if (r.predictions.length === 0) return 0;
  return r.predictions.reduce((s, x) => s + x.miss_probability, 0) / r.predictions.length;
}

function highCount(r: PredictResponse): number {
  return r.predictions.filter((d) => d.risk_tier === "high").length;
}

function maxMiss(r: PredictResponse): number {
  return r.predictions.reduce((m, x) => Math.max(m, x.miss_probability), 0);
}

function tierFill(tier: DosePrediction["risk_tier"]): string {
  return tier === "high"
    ? "var(--color-danger)"
    : tier === "medium"
      ? "var(--color-warn)"
      : "var(--color-success)";
}

function PersonaCard({ s }: { s: Scored }) {
  const r = s.result;
  const am = r ? avgMiss(r) : 0;
  const hc = r ? highCount(r) : 0;
  const mm = r ? maxMiss(r) : 0;

  const chartData = useMemo(() => {
    if (!r) return [];
    return r.predictions.map((d, i) => ({
      idx: `d${i + 1}`,
      dose_id: d.dose_id,
      miss: Number((d.miss_probability * 100).toFixed(1)),
      tier: d.risk_tier,
    }));
  }, [r]);

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={s.persona.name}
        hint={`${s.persona.age} y/o · ${s.persona.conditions.join(", ")}`}
        right={
          s.loading ? (
            <Spinner className="animate-spin text-[var(--color-muted)]" size={16} />
          ) : s.error ? (
            <WarningCircle weight="duotone" size={16} className="text-[var(--color-danger)]" />
          ) : r ? (
            <CheckCircle weight="duotone" size={16} className="text-[var(--color-success)]" />
          ) : null
        }
      />
      <div className="p-4 flex flex-col gap-4 flex-1">
        <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">{s.persona.blurb}</p>

        {s.error ? (
          <ErrorBox message={s.error} />
        ) : s.loading && !r ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : r ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded border border-[var(--color-border)] px-2 py-1.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                  avg miss
                </div>
                <div className="text-[15px] font-semibold tabular-nums">{fmtPct(am)}</div>
              </div>
              <div className="rounded border border-[var(--color-border)] px-2 py-1.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                  high risk
                </div>
                <div className="text-[15px] font-semibold tabular-nums">
                  {hc}
                  <span className="text-[10px] text-[var(--color-muted)] ml-1">
                    / {r.predictions.length}
                  </span>
                </div>
              </div>
              <div className="rounded border border-[var(--color-border)] px-2 py-1.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                  peak
                </div>
                <div className="text-[15px] font-semibold tabular-nums">{fmtPct(mm)}</div>
              </div>
            </div>

            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="idx"
                    tick={{ fontSize: 10, fill: "var(--color-muted)" }}
                    axisLine={{ stroke: "var(--color-border)" }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 10, fill: "var(--color-muted)" }}
                    axisLine={false}
                    tickLine={false}
                    unit="%"
                  />
                  <Tooltip
                    cursor={{ fill: "var(--color-border)", opacity: 0.3 }}
                    contentStyle={{
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      fontSize: 11,
                      borderRadius: 4,
                    }}
                    formatter={(v: number, _n, item: { payload?: { dose_id?: string; tier?: string } }) => [
                      `${v}%`,
                      item?.payload?.dose_id ?? "miss",
                    ]}
                  />
                  <Bar dataKey="miss" radius={[2, 2, 0, 0]}>
                    {chartData.map((d, i) => (
                      <Cell key={i} fill={tierFill(d.tier as DosePrediction["risk_tier"])} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
              model {r.model_version} · {s.latency_ms}ms
            </div>
          </>
        ) : (
          <Empty title="Not scored yet" />
        )}
      </div>
    </Card>
  );
}

export default function CompareClient() {
  const anchor = useMemo(() => new Date(), []);
  const [scored, setScored] = useState<Scored[]>(() =>
    PERSONAS.map((p) => ({ persona: p, result: null, error: null, latency_ms: null, loading: false })),
  );
  const [runAt, setRunAt] = useState<number | null>(null);
  const allLoading = scored.some((s) => s.loading);

  const runAll = useCallback(async () => {
    setScored((prev) =>
      prev.map((s) => ({ ...s, loading: true, error: null, result: null, latency_ms: null })),
    );
    const results = await Promise.allSettled(PERSONAS.map((p) => scoreOne(p, anchor)));
    setScored(
      PERSONAS.map((p, i) => {
        const r = results[i];
        if (r.status === "fulfilled") {
          return { persona: p, result: r.value.result, error: null, latency_ms: r.value.latency_ms, loading: false };
        }
        return {
          persona: p,
          result: null,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          latency_ms: null,
          loading: false,
        };
      }),
    );
    setRunAt(Date.now());
  }, [anchor]);

  useEffect(() => {
    runAll();
  }, [runAll]);

  // Ranked: who needs intervention first?
  const ranking = useMemo(() => {
    return scored
      .filter((s) => s.result != null)
      .map((s) => {
        const r = s.result!;
        const score = avgMiss(r) * 0.5 + maxMiss(r) * 0.3 + (highCount(r) / Math.max(1, r.predictions.length)) * 0.2;
        return { s, score, avg: avgMiss(r), high: highCount(r), peak: maxMiss(r), n: r.predictions.length };
      })
      .sort((a, b) => b.score - a.score);
  }, [scored]);

  // Aggregated top reasons across all scored doses.
  const topReasons = useMemo(() => {
    const acc = new Map<string, { feature: string; human: string; contribution: number; count: number }>();
    scored.forEach((s) => {
      s.result?.predictions.forEach((d) => {
        d.reasons.forEach((r: ReasonCode) => {
          const key = r.feature;
          const prev = acc.get(key);
          if (prev) {
            prev.contribution += Math.abs(r.contribution);
            prev.count += 1;
          } else {
            acc.set(key, { feature: r.feature, human: r.human, contribution: Math.abs(r.contribution), count: 1 });
          }
        });
      });
    });
    return Array.from(acc.values())
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 6);
  }, [scored]);

  const maxReason = Math.max(1e-6, ...topReasons.map((r) => r.contribution));

  return (
    <div className="flex flex-col">
      <PageHeader
        eyebrow="Compare"
        title="Score the whole cohort at once"
        description="Runs the same calibrated ensemble on all three demo personas in parallel, then ranks who needs an intervention first."
        actions={
          <Button onClick={runAll} disabled={allLoading}>
            {allLoading ? (
              <Spinner className="animate-spin" size={14} />
            ) : (
              <ArrowsClockwise weight="duotone" size={14} />
            )}
            <span>{allLoading ? "Scoring" : "Rescore"}</span>
          </Button>
        }
      />

      <div className="p-6 flex flex-col gap-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {scored.map((s) => (
            <PersonaCard key={s.persona.id} s={s} />
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader
              title="Triage order"
              hint="Composite of average, peak, and high-risk share"
              right={<Trophy weight="duotone" size={16} className="text-[var(--color-accent)]" />}
            />
            <div className="p-4">
              {ranking.length === 0 ? (
                <Empty title="No scored patients" />
              ) : (
                <ol className="flex flex-col gap-2">
                  {ranking.map((row, i) => {
                    const tone = i === 0 ? "danger" : i === 1 ? "warn" : "success";
                    return (
                      <li
                        key={row.s.persona.id}
                        className="flex items-center justify-between gap-3 rounded border border-[var(--color-border)] px-3 py-2.5"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span
                            className={cn(
                              "h-6 w-6 grid place-items-center rounded text-[11px] font-mono font-semibold tabular-nums",
                              i === 0
                                ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)]"
                                : i === 1
                                  ? "bg-[var(--color-warn)]/15 text-[var(--color-warn)]"
                                  : "bg-[var(--color-success)]/15 text-[var(--color-success)]",
                            )}
                          >
                            {i + 1}
                          </span>
                          <User weight="duotone" size={16} className="text-[var(--color-muted)] shrink-0" />
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium truncate">{row.s.persona.name}</div>
                            <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                              {row.high}/{row.n} high · avg {fmtPct(row.avg)} · peak {fmtPct(row.peak)}
                            </div>
                          </div>
                        </div>
                        <Badge tone={tone as "danger" | "warn" | "success"}>
                          {i === 0 ? "Intervene first" : i === 1 ? "Monitor" : "Stable"}
                        </Badge>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="What drives miss risk across this cohort"
              hint="Mean absolute SHAP across every scored dose"
              right={<ChartBar weight="duotone" size={16} className="text-[var(--color-accent)]" />}
            />
            <div className="p-4">
              {topReasons.length === 0 ? (
                <Empty title="No reasons yet" />
              ) : (
                <ul className="flex flex-col gap-2">
                  {topReasons.map((r) => {
                    const pct = (r.contribution / maxReason) * 100;
                    return (
                      <li key={r.feature} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between text-[12px]">
                          <span className="truncate text-[var(--color-fg)]">{r.human}</span>
                          <span className="font-mono tabular-nums text-[var(--color-muted)]">
                            {r.contribution.toFixed(3)}
                            <span className="text-[10px] ml-1">×{r.count}</span>
                          </span>
                        </div>
                        <div className="h-1.5 rounded bg-[var(--color-border)]/40 overflow-hidden">
                          <div
                            className="h-full bg-[var(--color-accent)]"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
          <div className="flex items-center gap-2">
            <Lightning weight="duotone" size={14} className="text-[var(--color-accent)]" />
            <span>
              {scored.filter((s) => s.result).length}/{scored.length} scored
              {runAt ? ` · last run ${new Date(runAt).toLocaleTimeString()}` : ""}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/demo"
              className="inline-flex items-center gap-1 text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              <span>Single persona deep dive</span>
              <ArrowRight weight="duotone" size={12} />
            </Link>
            <Link
              href="/interventions"
              className="inline-flex items-center gap-1 text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              <Bell weight="duotone" size={12} />
              <span>Queue interventions</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
