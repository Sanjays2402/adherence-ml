"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
  ReferenceLine,
} from "recharts";
import { cn } from "@/lib/utils";
import type { ExplainSampleRow } from "@/lib/types";

const ACCENT = "var(--color-accent)";

/**
 * Real SHAP-style waterfall. Bars stack from a base rate to the final
 * predicted log-odds, with each feature pushing the prediction up (red) or
 * down (emerald). We render in probability space using the logit base rate
 * passed in; the waterfall steps are the per-feature shap_values.
 */
export function ShapWaterfall({
  row,
  baseRate = 0.18,
  topK = 12,
}: {
  row: ExplainSampleRow;
  baseRate?: number;
  topK?: number;
}) {
  const entries = Object.entries(row.shap_values)
    .map(([feature, sv]) => ({
      feature,
      shap: sv,
      value: row.feature_values[feature] ?? 0,
    }))
    .sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap))
    .slice(0, topK);

  // Build cumulative steps in logit space so the magnitudes match SHAP semantics.
  const baseLogit = Math.log(baseRate / (1 - baseRate));
  let cum = baseLogit;

  const rows = [
    {
      feature: "base rate",
      shap: 0,
      value: baseRate,
      start: 0,
      end: baseLogit,
      isBase: true,
    },
    ...entries.map((e) => {
      const start = cum;
      const end = cum + e.shap;
      cum = end;
      return { ...e, start, end, isBase: false };
    }),
    {
      feature: "final",
      shap: 0,
      value: row.miss_probability,
      start: 0,
      end: cum,
      isBase: true,
    },
  ];

  // Pivot for Recharts: a bar from `lo` to `hi` per row, plus a sign for color.
  const chartData = rows.map((r) => {
    const lo = Math.min(r.start, r.end);
    const hi = Math.max(r.start, r.end);
    return {
      feature: r.feature,
      offset: lo,
      bar: hi - lo,
      sign: r.isBase ? "base" : r.end > r.start ? "pos" : "neg",
      shap: r.shap,
      value: r.value,
    };
  });

  const min = Math.min(...chartData.map((d) => d.offset));
  const max = Math.max(...chartData.map((d) => d.offset + d.bar));
  const pad = (max - min) * 0.08 || 0.5;

  return (
    <div className="h-[480px] px-2 pt-3 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={chartData}
          margin={{ left: 8, right: 24, top: 8, bottom: 4 }}
          barCategoryGap={4}
        >
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" horizontal={false} />
          <XAxis
            type="number"
            domain={[min - pad, max + pad]}
            tick={{ fill: "var(--color-muted)", fontSize: 10 }}
            stroke="var(--color-border-strong)"
            tickFormatter={(v) => v.toFixed(2)}
            label={{ value: "logit p(miss)", position: "insideBottom", offset: -2, fill: "var(--color-subtle)", fontSize: 10 }}
          />
          <YAxis
            type="category"
            dataKey="feature"
            tick={{ fill: "var(--color-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}
            stroke="var(--color-border-strong)"
            width={180}
          />
          <ReferenceLine x={0} stroke="var(--color-subtle)" strokeDasharray="3 3" />
          <Tooltip
            cursor={{ fill: "var(--color-border)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as any;
              return (
                <div className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs font-mono tabular-nums shadow-lg">
                  <div className="text-[var(--color-fg)]">{d.feature}</div>
                  <div className="text-[var(--color-muted)] mt-0.5">
                    value <span className="text-[var(--color-fg)]">{Number(d.value).toFixed(3)}</span>
                  </div>
                  {d.sign !== "base" && (
                    <div className="text-[var(--color-muted)]">
                      shap{" "}
                      <span
                        className={
                          d.sign === "pos"
                            ? "text-[var(--color-high)]"
                            : "text-[var(--color-low)]"
                        }
                      >
                        {d.shap >= 0 ? "+" : ""}
                        {Number(d.shap).toFixed(4)}
                      </span>
                    </div>
                  )}
                </div>
              );
            }}
          />
          {/* Invisible offset bar to position the visible bar at the cumulative start. */}
          <Bar dataKey="offset" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="bar" stackId="w" isAnimationActive={false} radius={[0, 2, 2, 0]}>
            {chartData.map((d, i) => {
              const fill =
                d.sign === "pos"
                  ? "var(--color-high)"
                  : d.sign === "neg"
                    ? "var(--color-low)"
                    : ACCENT;
              return <Cell key={i} fill={fill} fillOpacity={d.sign === "base" ? 0.6 : 0.85} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ShapLegend() {
  return (
    <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)]">
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-sm bg-[var(--color-accent)]" /> base / final
      </span>
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-sm bg-[var(--color-high)]" /> pushes miss up
      </span>
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-sm bg-[var(--color-low)]" /> pushes miss down
      </span>
    </div>
  );
}

export function ContributionBars({
  row,
  topK = 10,
}: {
  row: ExplainSampleRow;
  topK?: number;
}) {
  const entries = Object.entries(row.shap_values)
    .map(([feature, sv]) => ({
      feature,
      shap: sv,
      value: row.feature_values[feature] ?? 0,
    }))
    .sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap))
    .slice(0, topK);
  const maxAbs = Math.max(...entries.map((e) => Math.abs(e.shap)), 1e-9);
  return (
    <div className="space-y-1.5">
      {entries.map((e) => {
        const pos = e.shap >= 0;
        const w = (Math.abs(e.shap) / maxAbs) * 100;
        return (
          <div
            key={e.feature}
            className="text-xs grid grid-cols-[1.2fr_2fr_auto] items-center gap-3"
          >
            <div className="font-mono truncate text-[var(--color-muted)]" title={e.feature}>
              {e.feature}
            </div>
            <div className="relative h-2 bg-[var(--color-border)]/40 rounded">
              <div className="absolute top-0 bottom-0 left-1/2 w-px bg-[var(--color-border-strong)]" />
              <div
                className={cn(
                  "absolute top-0 bottom-0 rounded",
                  pos ? "bg-[var(--color-high)]/80" : "bg-[var(--color-low)]/80",
                )}
                style={{ width: `${w / 2}%`, [pos ? "left" : "right"]: "50%" }}
              />
            </div>
            <div className="font-mono tabular-nums text-right w-28">
              <span
                className={pos ? "text-[var(--color-high)]" : "text-[var(--color-low)]"}
              >
                {pos ? "+" : ""}
                {e.shap.toFixed(4)}
              </span>
              <span className="text-[var(--color-subtle)] ml-1">
                ({e.value.toFixed(2)})
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
