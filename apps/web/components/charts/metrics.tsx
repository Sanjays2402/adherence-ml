"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
  Area,
  AreaChart,
} from "recharts";
import type { CalibrationBin } from "@/lib/types";
import { fmtPct } from "@/lib/utils";

const TICK = { fill: "var(--color-muted)", fontSize: 11 };
const AXIS = { stroke: "var(--color-border-strong)" };
const GRID = "var(--color-border)";
const ACCENT = "var(--color-accent)";

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs shadow-lg font-mono tabular-nums">
      {label !== undefined ? (
        <div className="text-[var(--color-muted)] mb-1">{label}</div>
      ) : null}
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: p.color }}
          />
          <span className="text-[var(--color-muted)]">{p.name}</span>
          <span className="ml-auto">
            {typeof p.value === "number" ? p.value.toFixed(3) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* Reliability diagram: predicted vs observed per bin, with perfect-calibration diagonal. */
export function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const data = bins
    .filter((b) => b.n > 0)
    .map((b) => ({
      mid: (b.p_lo + b.p_hi) / 2,
      predicted: b.mean_pred,
      observed: b.miss_rate,
      n: b.n,
    }));
  const empty = data.length === 0;
  const sample = empty ? syntheticReliability() : data;
  return (
    <div className="relative h-72 px-2 pt-3 pb-1">
      {empty ? (
        <div className="absolute right-3 top-2 z-10 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)]/80 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)]">
          sample data
        </div>
      ) : null}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={sample} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="2 4" />
          <XAxis
            dataKey="mid"
            type="number"
            domain={[0, 1]}
            tickFormatter={(v) => v.toFixed(1)}
            tick={TICK}
            {...AXIS}
            label={{ value: "predicted p(miss)", position: "insideBottom", offset: -2, fill: "var(--color-subtle)", fontSize: 10 }}
          />
          <YAxis
            type="number"
            domain={[0, 1]}
            tickFormatter={(v) => v.toFixed(1)}
            tick={TICK}
            {...AXIS}
            width={32}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--color-border-strong)" }} />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke="var(--color-subtle)"
            strokeDasharray="3 3"
            label={{ value: "perfect", position: "insideTopLeft", fill: "var(--color-subtle)", fontSize: 10 }}
          />
          <Line
            type="monotone"
            dataKey="predicted"
            name="predicted"
            stroke="var(--color-muted)"
            strokeWidth={1.25}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="observed"
            name="observed"
            stroke={ACCENT}
            strokeWidth={2}
            dot={{ r: 3, fill: ACCENT, stroke: "var(--color-bg)", strokeWidth: 1 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BinVolumeChart({ bins }: { bins: CalibrationBin[] }) {
  const data = bins.map((b, i) => ({
    name: `${b.p_lo.toFixed(1)}-${b.p_hi.toFixed(1)}`,
    n: b.n,
    idx: i,
  }));
  return (
    <div className="h-40 px-2 pt-2 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="name" tick={{ ...TICK, fontSize: 10 }} {...AXIS} />
          <YAxis tick={TICK} {...AXIS} width={32} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-border)" }} />
          <Bar dataKey="n" name="doses" radius={[2, 2, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} fill={ACCENT} fillOpacity={0.6} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ByModelRow({
  name,
  n,
  auc,
  brier,
  missRate,
}: {
  name: string;
  n: number;
  auc: number | null;
  brier: number;
  missRate: number;
}) {
  const tier = missRate >= 0.4 ? "rail-high" : missRate >= 0.2 ? "rail-mid" : "rail-low";
  return (
    <div className={`grid grid-cols-5 items-center gap-2 pl-4 pr-4 py-2 text-sm border-b border-[var(--color-border)] last:border-b-0 ${tier}`}>
      <div className="font-mono text-xs truncate">{name}</div>
      <div className="tabular-nums font-mono text-xs text-right text-[var(--color-muted)]">{n}</div>
      <div className="tabular-nums font-mono text-xs text-right">
        {auc != null ? auc.toFixed(3) : "n/a"}
      </div>
      <div className="tabular-nums font-mono text-xs text-right">{brier.toFixed(3)}</div>
      <div className="tabular-nums font-mono text-xs text-right">{fmtPct(missRate)}</div>
    </div>
  );
}

/* AUC-over-time area chart. Accepts a time series; falls back to synthetic warmup. */
export function AucOverTimeChart({
  series,
  metric = "AUC",
}: {
  series: { t: number; v: number }[];
  metric?: string;
}) {
  const data = series.map((p) => ({
    t: new Date(p.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    v: Number(p.v.toFixed(4)),
  }));
  return (
    <div className="h-56 px-2 pt-3 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <defs>
            <linearGradient id="auc-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="t" tick={{ ...TICK, fontSize: 10 }} {...AXIS} interval="preserveStartEnd" />
          <YAxis tick={TICK} {...AXIS} width={36} domain={["auto", "auto"]} tickFormatter={(v) => v.toFixed(2)} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--color-border-strong)" }} />
          <Area
            type="monotone"
            dataKey="v"
            name={metric}
            stroke={ACCENT}
            strokeWidth={1.75}
            fill="url(#auc-fill)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Prediction distribution histogram. Bins probabilities into 20 buckets and colors
 * them red/amber/emerald according to the risk tier they fall into. */
export function PredictionDistributionChart({
  bins,
}: {
  bins: CalibrationBin[];
}) {
  // expand calibration bins (10 buckets of size 0.1) into 20 buckets when possible.
  const data = bins.length
    ? bins.map((b) => ({
        mid: (b.p_lo + b.p_hi) / 2,
        n: b.n,
      }))
    : syntheticHistogram();
  return (
    <div className="h-56 px-2 pt-3 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="mid"
            tickFormatter={(v) => Number(v).toFixed(1)}
            tick={{ ...TICK, fontSize: 10 }}
            {...AXIS}
          />
          <YAxis tick={TICK} {...AXIS} width={36} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-border)" }} />
          <Bar dataKey="n" name="predictions" radius={[2, 2, 0, 0]}>
            {data.map((d, i) => {
              const c =
                d.mid >= 0.7
                  ? "var(--color-high)"
                  : d.mid >= 0.4
                    ? "var(--color-mid)"
                    : "var(--color-low)";
              return <Cell key={i} fill={c} fillOpacity={0.7} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ---------- synthetic fallbacks ---------- */

function syntheticReliability() {
  // a believable mildly under-confident model
  return Array.from({ length: 10 }, (_, i) => {
    const mid = (i + 0.5) / 10;
    const observed = Math.min(0.98, Math.max(0.02, mid + 0.04 * Math.sin(i)));
    return { mid, predicted: mid, observed, n: 0 };
  });
}

function syntheticHistogram() {
  // bimodal-ish: most predictions low, smaller bump near 0.7
  return Array.from({ length: 20 }, (_, i) => {
    const mid = (i + 0.5) / 20;
    const lowMode = 600 * Math.exp(-Math.pow((mid - 0.15) / 0.1, 2));
    const highMode = 220 * Math.exp(-Math.pow((mid - 0.72) / 0.08, 2));
    return { mid, n: Math.round(lowMode + highMode + 8) };
  });
}
