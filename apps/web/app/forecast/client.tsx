"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import {
  CalendarBlank,
  Spinner,
  ArrowsClockwise,
  WarningCircle,
  User,
  Sparkle,
  TrendUp,
  TrendDown,
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
  MonoChip,
} from "@/components/ui/primitives";
import type { ForecastResponse } from "@/lib/types";
import { fmtPct, cn } from "@/lib/utils";
import { PERSONAS, type Persona } from "../demo/personas";

const HORIZONS = [3, 7, 14] as const;
type Horizon = (typeof HORIZONS)[number];

function buildHistoryPayload(p: Persona, anchor: Date) {
  const anchor_ms = anchor.getTime();
  return p.history.map((h) => {
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
  });
}

interface RowDatum {
  date: string;
  shortDate: string;
  rate: number;
  ratePct: number;
  ciLow: number;
  ciHigh: number;
  ciBand: [number, number];
  doses: number;
  highRisk: number;
  missMean: number;
}

function buildChartData(res: ForecastResponse): RowDatum[] {
  // The API gives a single overall CI, not per-day. We render the CI as a
  // horizontal band across the whole chart via ReferenceLines, and per-day
  // bars/points for daily projected adherence. We still attach the overall
  // CI on each row so tooltips can reference it.
  return res.by_day.map((d) => {
    const dt = new Date(d.date + "T00:00:00");
    const shortDate = dt.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    return {
      date: d.date,
      shortDate,
      rate: d.projected_adherence_rate,
      ratePct: d.projected_adherence_rate * 100,
      ciLow: res.overall_adherence_ci_low,
      ciHigh: res.overall_adherence_ci_high,
      ciBand: [
        res.overall_adherence_ci_low * 100,
        res.overall_adherence_ci_high * 100,
      ],
      doses: d.n_doses,
      highRisk: d.high_risk_count,
      missMean: d.mean_miss_probability,
    };
  });
}

function rateColor(rate: number): string {
  if (rate >= 0.9) return "var(--color-low)";
  if (rate >= 0.75) return "var(--color-mid)";
  return "var(--color-high)";
}

export default function ForecastClient() {
  const [selectedId, setSelectedId] = useState<string>(PERSONAS[1].id);
  const [horizon, setHorizon] = useState<Horizon>(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ForecastResponse | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const persona = useMemo(
    () => PERSONAS.find((p) => p.id === selectedId) ?? PERSONAS[0],
    [selectedId],
  );

  const run = useCallback(
    async (p: Persona, h: Horizon) => {
      setLoading(true);
      setError(null);
      const anchor = new Date();
      const payload = {
        user_id: p.user_id,
        history: buildHistoryPayload(p, anchor),
        horizon_days: h,
        starting_at: anchor.toISOString(),
        bootstrap_iterations: 200,
        seed: 11,
      };
      const t0 = performance.now();
      try {
        const r = await fetch("/api/proxy/v1/forecast/user", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (!r.ok) {
          const detail =
            typeof data?.detail === "string"
              ? data.detail
              : `forecast failed (${r.status})`;
          throw new Error(detail);
        }
        setResult(data as ForecastResponse);
        setElapsedMs(Math.round(performance.now() - t0));
      } catch (e) {
        setError(e instanceof Error ? e.message : "request failed");
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Auto-run on mount and when persona/horizon change.
  useEffect(() => {
    run(persona, horizon);
  }, [persona, horizon, run]);

  const chartData = useMemo(
    () => (result ? buildChartData(result) : []),
    [result],
  );

  const overallPct = result ? result.overall_projected_adherence_rate : null;
  const ciLowPct = result ? result.overall_adherence_ci_low : null;
  const ciHighPct = result ? result.overall_adherence_ci_high : null;
  const totalHighRisk = useMemo(
    () => result?.by_day.reduce((a, d) => a + d.high_risk_count, 0) ?? 0,
    [result],
  );
  const trend = useMemo(() => {
    if (!result || result.by_day.length < 2) return 0;
    const first = result.by_day[0].projected_adherence_rate;
    const last = result.by_day[result.by_day.length - 1].projected_adherence_rate;
    return last - first;
  }, [result]);

  return (
    <div className="px-4 md:px-8 py-6 md:py-10 max-w-6xl mx-auto space-y-6">
      <PageHeader
        eyebrow="forecast"
        title="Projected adherence, next few days"
        description="Pick a patient. We score their upcoming schedule one day at a time and roll the per-dose miss probabilities into a daily adherence rate plus a bootstrap 90 percent confidence interval on the overall window."
      />

      <Card>
        <CardHeader
          title="Patient"
          hint="Three preloaded personas with 14 days of synthetic history."
          right={<User weight="duotone" size={14} className="text-[var(--color-muted)]" />}
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3 p-3 md:p-4">
          {PERSONAS.map((p) => {
            const active = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  "text-left rounded-lg border px-3 py-3 transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]",
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
                    : "border-[var(--color-border)] hover:bg-[var(--color-border)]/20",
                )}
                aria-pressed={active}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{p.name}</span>
                  <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-subtle)]">
                    age {p.age}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[var(--color-muted)] leading-snug">
                  {p.blurb}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.conditions.map((c) => (
                    <Badge key={c} tone="neutral">
                      {c}
                    </Badge>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {HORIZONS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHorizon(h)}
              className={cn(
                "text-xs font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm transition-colors",
                h === horizon
                  ? "bg-[var(--color-accent-soft)] text-[var(--color-fg)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-fg)]",
              )}
              aria-pressed={h === horizon}
            >
              {h}d
            </button>
          ))}
        </div>
        <Button
          type="button"
          onClick={() => run(persona, horizon)}
          variant="ghost"
          disabled={loading}
        >
          {loading ? (
            <Spinner weight="duotone" size={14} className="animate-spin" />
          ) : (
            <ArrowsClockwise weight="duotone" size={14} />
          )}
          <span>Rerun</span>
        </Button>
        {elapsedMs != null && !loading && (
          <MonoChip>{elapsedMs} ms</MonoChip>
        )}
        {result && (
          <MonoChip>schedule: {result.schedule_source}</MonoChip>
        )}
        {result && (
          <MonoChip>model {result.model_version || "n/a"}</MonoChip>
        )}
      </div>

      {error && <ErrorBox message={error} />}

      {!error && loading && !result && (
        <Card>
          <div className="p-6 space-y-3">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-64 w-full" />
          </div>
        </Card>
      )}

      {!error && !loading && result && result.n_doses_scored === 0 && (
        <Empty
          icon={<WarningCircle weight="duotone" size={20} />}
          title="No doses to score"
          hint="This persona has no upcoming schedule we could derive. Pick a different sample."
        />
      )}

      {result && result.n_doses_scored > 0 && overallPct != null && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-1">
            <CardHeader
              title="Projected adherence"
              hint={`Across ${result.horizon_days} days // ${result.n_doses_scored} doses`}
              right={<Sparkle weight="duotone" size={14} className="text-[var(--color-accent)]" />}
            />
            <div className="p-5 space-y-4">
              <div>
                <div
                  className="text-5xl font-semibold tabular-nums"
                  style={{ color: rateColor(overallPct) }}
                >
                  {fmtPct(overallPct, 1)}
                </div>
                <div className="mt-1 text-xs font-mono uppercase tracking-wider text-[var(--color-subtle)]">
                  overall miss-prob mean{" "}
                  {fmtPct(1 - overallPct, 1)}
                </div>
              </div>
              <div className="border-t border-[var(--color-border)] pt-3">
                <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
                  90% bootstrap CI
                </div>
                <div className="mt-1 text-sm tabular-nums">
                  {fmtPct(ciLowPct, 1)} <span className="text-[var(--color-subtle)]">to</span>{" "}
                  {fmtPct(ciHighPct, 1)}
                </div>
                <div className="mt-2 h-2 rounded-full bg-[var(--color-border)]/40 relative overflow-hidden">
                  <div
                    className="absolute h-full rounded-full"
                    style={{
                      left: `${(ciLowPct ?? 0) * 100}%`,
                      width: `${(((ciHighPct ?? 0) - (ciLowPct ?? 0)) * 100).toFixed(2)}%`,
                      backgroundColor: rateColor(overallPct),
                      opacity: 0.35,
                    }}
                  />
                  <div
                    className="absolute top-[-2px] h-[calc(100%+4px)] w-[2px]"
                    style={{
                      left: `${overallPct * 100}%`,
                      backgroundColor: rateColor(overallPct),
                    }}
                    aria-hidden
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-3">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
                    high-risk doses
                  </div>
                  <div className="mt-0.5 text-xl tabular-nums">{totalHighRisk}</div>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
                    window trend
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-xl tabular-nums">
                    {trend >= 0 ? (
                      <TrendUp
                        weight="duotone"
                        size={18}
                        className="text-[var(--color-low)]"
                      />
                    ) : (
                      <TrendDown
                        weight="duotone"
                        size={18}
                        className="text-[var(--color-high)]"
                      />
                    )}
                    <span>
                      {trend >= 0 ? "+" : ""}
                      {(trend * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader
              title="Daily projection"
              hint="Bars are dose count per day. Line is projected adherence rate. Dashed lines mark the overall window CI."
              right={<CalendarBlank weight="duotone" size={14} className="text-[var(--color-muted)]" />}
            />
            <div className="p-3 md:p-4">
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 10, right: 16, bottom: 0, left: -10 }}
                  >
                    <CartesianGrid
                      stroke="var(--color-border)"
                      strokeDasharray="2 4"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="shortDate"
                      tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                      axisLine={{ stroke: "var(--color-border)" }}
                      tickLine={false}
                      interval={0}
                    />
                    <YAxis
                      yAxisId="left"
                      domain={[0, 100]}
                      tickFormatter={(v) => `${v}%`}
                      tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                      axisLine={{ stroke: "var(--color-border)" }}
                      tickLine={false}
                      width={44}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      allowDecimals={false}
                      tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                      axisLine={{ stroke: "var(--color-border)" }}
                      tickLine={false}
                      width={28}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--color-border)", fillOpacity: 0.15 }}
                      contentStyle={{
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value: number | string, name: string) => {
                        if (name === "Adherence")
                          return [`${Number(value).toFixed(1)}%`, name];
                        return [value, name];
                      }}
                    />
                    <ReferenceLine
                      yAxisId="left"
                      y={(ciLowPct ?? 0) * 100}
                      stroke="var(--color-accent)"
                      strokeDasharray="4 4"
                      strokeOpacity={0.6}
                    />
                    <ReferenceLine
                      yAxisId="left"
                      y={(ciHighPct ?? 0) * 100}
                      stroke="var(--color-accent)"
                      strokeDasharray="4 4"
                      strokeOpacity={0.6}
                    />
                    <Bar
                      yAxisId="right"
                      dataKey="doses"
                      name="Doses"
                      fill="var(--color-border)"
                      radius={[4, 4, 0, 0]}
                      barSize={22}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="ratePct"
                      name="Adherence"
                      stroke="var(--color-accent)"
                      strokeWidth={2}
                      dot={(props: {
                        cx?: number;
                        cy?: number;
                        index?: number;
                        payload?: RowDatum;
                      }) => {
                        const { cx, cy, payload, index } = props;
                        if (cx == null || cy == null || !payload) {
                          return <g key={`d-${index ?? 0}`} />;
                        }
                        return (
                          <circle
                            key={`d-${index ?? 0}`}
                            cx={cx}
                            cy={cy}
                            r={4}
                            fill={rateColor(payload.rate)}
                            stroke="var(--color-bg)"
                            strokeWidth={1.5}
                          />
                        );
                      }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="border-t border-[var(--color-border)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-subtle)]">
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="text-left px-4 py-2 font-normal">Date</th>
                    <th className="text-right px-4 py-2 font-normal">Doses</th>
                    <th className="text-right px-4 py-2 font-normal">High risk</th>
                    <th className="text-right px-4 py-2 font-normal">Miss prob</th>
                    <th className="text-right px-4 py-2 font-normal">Adherence</th>
                  </tr>
                </thead>
                <tbody>
                  {result.by_day.map((d) => (
                    <tr
                      key={d.date}
                      className="border-b border-[var(--color-border)]/60 last:border-0"
                    >
                      <td className="px-4 py-2 font-mono text-xs">{d.date}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {d.n_doses}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2 text-right tabular-nums",
                          d.high_risk_count > 0
                            ? "text-[var(--color-high)]"
                            : "text-[var(--color-subtle)]",
                        )}
                      >
                        {d.high_risk_count}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-[var(--color-muted)]">
                        {fmtPct(d.mean_miss_probability, 1)}
                      </td>
                      <td
                        className="px-4 py-2 text-right tabular-nums font-medium"
                        style={{ color: rateColor(d.projected_adherence_rate) }}
                      >
                        {fmtPct(d.projected_adherence_rate, 1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
