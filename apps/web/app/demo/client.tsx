"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  CartesianGrid,
} from "recharts";
import {
  Lightning,
  Spinner,
  CheckCircle,
  WarningCircle,
  Pill,
  User,
  ClockCounterClockwise,
  ArrowRight,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  ErrorBox,
  Empty,
  Badge,
} from "@/components/ui/primitives";
import type { PredictResponse, DosePrediction } from "@/lib/types";
import { fmtPct, fmtTime, cn } from "@/lib/utils";
import { PERSONAS, type Persona } from "./personas";

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

function riskTone(t: DosePrediction["risk_tier"]): "danger" | "warn" | "success" {
  return t === "high" ? "danger" : t === "medium" ? "warn" : "success";
}

function riskColor(t: DosePrediction["risk_tier"]): string {
  return t === "high"
    ? "var(--color-danger)"
    : t === "medium"
      ? "var(--color-warn)"
      : "var(--color-success)";
}

function adherenceFromHistory(p: Persona) {
  const total = p.history.length;
  if (!total) return null;
  const taken = p.history.filter((h) => h.status === "taken").length;
  return taken / total;
}

export default function DemoClient() {
  const [activeId, setActiveId] = useState<string>(PERSONAS[0].id);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PredictResponse | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [scoredAt, setScoredAt] = useState<string | null>(null);

  const active = useMemo(
    () => PERSONAS.find((p) => p.id === activeId) ?? PERSONAS[0],
    [activeId],
  );
  const adherence = useMemo(() => adherenceFromHistory(active), [active]);

  const run = useCallback(
    async (persona: Persona) => {
      setSubmitting(true);
      setError(null);
      setResult(null);
      setLatencyMs(null);
      setScoredAt(null);
      const t0 = performance.now();
      try {
        const payload = buildPayload(persona, new Date());
        const res = await fetch("/api/proxy/v1/predict", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(
            typeof data?.detail === "string"
              ? data.detail
              : `Request failed (${res.status})`,
          );
        }
        const typed = data as PredictResponse;
        const elapsed = performance.now() - t0;
        setResult(typed);
        setLatencyMs(elapsed);
        setScoredAt(new Date().toISOString());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  // Auto-score the first persona on mount so a visitor sees a real result without clicking.
  useEffect(() => {
    run(PERSONAS[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPick(p: Persona) {
    setActiveId(p.id);
    run(p);
  }

  const chartData = useMemo(() => {
    if (!result) return [];
    const order: DosePrediction["risk_tier"][] = ["low", "medium", "high"];
    const counts: Record<string, number> = { low: 0, medium: 0, high: 0 };
    for (const p of result.predictions) counts[p.risk_tier] += 1;
    return order.map((tier) => ({
      tier,
      count: counts[tier],
      fill: riskColor(tier),
    }));
  }, [result]);

  const meanRisk = useMemo(() => {
    if (!result || result.predictions.length === 0) return null;
    const sum = result.predictions.reduce((a, p) => a + p.miss_probability, 0);
    return sum / result.predictions.length;
  }, [result]);

  return (
    <>
      <PageHeader
        eyebrow="demo // one click"
        title="Try a sample patient"
        description="Pick a persona. We send a real schedule plus 14 days of dosing history to the served model and render every prediction with its top contributing features."
      />

      <div className="p-4 sm:p-6 grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <div className="space-y-3">
          {PERSONAS.map((p) => {
            const isActive = p.id === active.id;
            const adh = adherenceFromHistory(p);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(p)}
                disabled={submitting}
                aria-pressed={isActive}
                className={cn(
                  "w-full text-left rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
                  isActive
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-border)] hover:border-[var(--color-fg)]/30",
                  submitting && !isActive && "opacity-60",
                )}
              >
                <div className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <User
                        weight="duotone"
                        size={18}
                        className="text-[var(--color-accent)] shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{p.name}</div>
                        <div className="text-[11px] font-mono text-[var(--color-muted)]">
                          age {p.age} · {p.schedule.length} doses queued
                        </div>
                      </div>
                    </div>
                    {isActive && submitting ? (
                      <Spinner
                        weight="duotone"
                        size={14}
                        className="animate-spin text-[var(--color-accent)]"
                      />
                    ) : isActive ? (
                      <ArrowRight
                        weight="duotone"
                        size={14}
                        className="text-[var(--color-accent)]"
                      />
                    ) : null}
                  </div>
                  <p className="text-xs text-[var(--color-muted)] leading-relaxed">
                    {p.blurb}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {p.conditions.map((c) => (
                      <Badge key={c} tone="neutral">
                        {c}
                      </Badge>
                    ))}
                  </div>
                  {adh != null ? (
                    <div className="flex items-center gap-2 pt-1 text-[11px] font-mono text-[var(--color-muted)]">
                      <ClockCounterClockwise weight="duotone" size={12} />
                      <span>14 d adherence</span>
                      <span className="tabular-nums text-[var(--color-fg)]/85">
                        {fmtPct(adh, 0)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
          <Button
            type="button"
            onClick={() => run(active)}
            disabled={submitting}
            className="w-full justify-center"
          >
            {submitting ? (
              <Spinner weight="duotone" size={14} className="animate-spin" />
            ) : (
              <Lightning weight="duotone" size={14} />
            )}
            {submitting ? "Scoring" : "Re-score this patient"}
          </Button>
        </div>

        <div className="space-y-6 min-w-0">
          <Card>
            <CardHeader
              title={`Result · ${active.name}`}
              hint={
                result
                  ? `model ${result.model_version}`
                  : submitting
                    ? "Calling /v1/predict"
                    : "No prediction yet"
              }
              right={
                result ? (
                  <Badge tone="success">
                    <CheckCircle weight="duotone" size={10} /> live
                  </Badge>
                ) : submitting ? (
                  <Badge tone="neutral">
                    <Spinner weight="duotone" size={10} className="animate-spin" />{" "}
                    scoring
                  </Badge>
                ) : error ? (
                  <Badge tone="danger">
                    <WarningCircle weight="duotone" size={10} /> error
                  </Badge>
                ) : null
              }
            />
            <div className="p-4">
              {error ? (
                <ErrorBox message={error} />
              ) : submitting && !result ? (
                <DemoSkeleton />
              ) : !result ? (
                <Empty
                  icon={<Lightning weight="duotone" size={20} />}
                  title="Pick a persona to score"
                  hint="Each click POSTs the schedule and history to /v1/predict."
                />
              ) : (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Stat
                    label="Doses scored"
                    value={String(result.predictions.length)}
                  />
                  <Stat
                    label="Mean miss risk"
                    value={meanRisk != null ? fmtPct(meanRisk) : "n/a"}
                  />
                  <Stat
                    label="Latency"
                    value={latencyMs != null ? `${Math.round(latencyMs)} ms` : "n/a"}
                    hint={scoredAt ? fmtTime(scoredAt) : undefined}
                  />
                </div>
              )}
            </div>
          </Card>

          {result && result.predictions.length > 0 ? (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <Card>
                <CardHeader
                  title="Risk distribution"
                  hint="dose count by tier"
                />
                <div className="p-4 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid
                        strokeDasharray="2 4"
                        stroke="var(--color-border)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="tier"
                        stroke="var(--color-muted)"
                        fontSize={11}
                        tickLine={false}
                        axisLine={{ stroke: "var(--color-border)" }}
                      />
                      <YAxis
                        allowDecimals={false}
                        stroke="var(--color-muted)"
                        fontSize={11}
                        tickLine={false}
                        axisLine={{ stroke: "var(--color-border)" }}
                        width={28}
                      />
                      <Tooltip
                        cursor={{ fill: "var(--color-border)", opacity: 0.4 }}
                        contentStyle={{
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-border)",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {chartData.map((d) => (
                          <Cell key={d.tier} fill={d.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Per-dose predictions"
                  hint={`${result.predictions.length} doses`}
                />
                <div className="divide-y divide-[var(--color-border)]">
                  {result.predictions.map((p) => {
                    const label =
                      active.schedule.find((s) => s.dose_id === p.dose_id)?.label ??
                      p.dose_id;
                    return (
                      <div key={p.dose_id} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium flex items-center gap-2">
                              <Pill
                                weight="duotone"
                                size={14}
                                className="text-[var(--color-muted)]"
                              />
                              <span className="truncate">{label}</span>
                            </div>
                            <div className="text-[11px] font-mono text-[var(--color-muted)] mt-0.5">
                              {fmtTime(p.scheduled_at)} · {p.dose_id}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div
                              className="text-base font-medium tabular-nums"
                              style={{ color: riskColor(p.risk_tier) }}
                            >
                              {fmtPct(p.miss_probability)}
                            </div>
                            <Badge tone={riskTone(p.risk_tier)}>{p.risk_tier}</Badge>
                          </div>
                        </div>
                        <div className="mt-2 h-1.5 rounded-full bg-[var(--color-border)]/50 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.min(100, p.miss_probability * 100)}%`,
                              background: riskColor(p.risk_tier),
                            }}
                          />
                        </div>
                        {p.reasons.length > 0 ? (
                          <ul className="mt-2 space-y-1">
                            {p.reasons.map((r, i) => (
                              <li
                                key={i}
                                className="text-xs flex items-start gap-2"
                              >
                                <span
                                  className={cn(
                                    "mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0",
                                  )}
                                  style={{
                                    background:
                                      r.contribution >= 0
                                        ? "var(--color-danger)"
                                        : "var(--color-success)",
                                  }}
                                />
                                <span className="text-[var(--color-fg)]/85">
                                  {r.human}
                                </span>
                                <span className="ml-auto tabular-nums text-[var(--color-muted)]">
                                  {r.contribution >= 0 ? "+" : ""}
                                  {r.contribution.toFixed(3)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
        {label}
      </div>
      <div className="text-xl font-medium tabular-nums mt-1">{value}</div>
      {hint ? (
        <div className="text-[11px] text-[var(--color-muted)] mt-0.5">{hint}</div>
      ) : null}
    </div>
  );
}

function DemoSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 w-1/3 rounded bg-[var(--color-border)]/60" />
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-16 rounded-md border border-[var(--color-border)] bg-[var(--color-border)]/30"
          />
        ))}
      </div>
    </div>
  );
}
