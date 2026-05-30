"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from "recharts";
import { ArrowUp, ArrowDown, Minus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export type SeriesPoint = { t: number; v: number };

/**
 * KpiTile: hero metric block with big tabular-nums value, delta arrow, and
 * an inline sparkline trendline. Used in the dashboard top strip.
 */
export function KpiTile({
  label,
  value,
  unit,
  series,
  better = "lower",
  precision = 3,
  hint,
  accent = false,
}: {
  label: string;
  value: number | null;
  unit?: string;
  series: SeriesPoint[];
  /** which direction is "good" for the delta color */
  better?: "lower" | "higher" | "neutral";
  precision?: number;
  hint?: string;
  accent?: boolean;
}) {
  const last = series.length ? series[series.length - 1].v : value ?? 0;
  const prev = series.length > 1 ? series[series.length - 2].v : last;
  const delta = last - prev;
  const pctDelta = prev !== 0 ? (delta / prev) * 100 : 0;
  const dir: "up" | "down" | "flat" =
    Math.abs(delta) < 1e-6 ? "flat" : delta > 0 ? "up" : "down";
  const good =
    better === "neutral" || dir === "flat"
      ? "neutral"
      : (better === "lower" && dir === "down") ||
          (better === "higher" && dir === "up")
        ? "good"
        : "bad";
  const deltaColor =
    good === "good"
      ? "text-[var(--color-low)]"
      : good === "bad"
        ? "text-[var(--color-high)]"
        : "text-[var(--color-muted)]";
  const stroke =
    good === "bad" ? "var(--color-high)" : good === "good" ? "var(--color-low)" : "var(--color-accent)";

  const Arrow = dir === "up" ? ArrowUp : dir === "down" ? ArrowDown : Minus;

  return (
    <div
      className={cn(
        "relative flex flex-col gap-2 px-4 py-3 border-r border-[var(--color-border)] last:border-r-0",
        accent && "bg-[var(--color-accent-soft)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-muted)]">
          {label}
        </div>
        {hint ? (
          <div className="text-[10px] font-mono text-[var(--color-subtle)]">{hint}</div>
        ) : null}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[28px] leading-none font-mono font-medium tabular-nums tracking-tight">
          {value == null || Number.isNaN(value) ? "n/a" : value.toFixed(precision)}
        </span>
        {unit ? (
          <span className="text-xs font-mono text-[var(--color-muted)]">{unit}</span>
        ) : null}
        <span className={cn("ml-auto inline-flex items-center gap-0.5 text-[11px] font-mono tabular-nums", deltaColor)}>
          <Arrow weight="bold" size={11} />
          {delta === 0
            ? "0"
            : `${delta > 0 ? "+" : ""}${delta.toFixed(precision)}`}
          <span className="text-[var(--color-subtle)] ml-1">
            ({pctDelta > 0 ? "+" : ""}{pctDelta.toFixed(1)}%)
          </span>
        </span>
      </div>
      <div className="h-10 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
            <defs>
              <linearGradient id={`spark-${label}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.45} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip
              cursor={false}
              content={({ active, payload }) =>
                active && payload?.length ? (
                  <div className="rounded border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-1 text-[10px] font-mono tabular-nums">
                    {Number(payload[0].value).toFixed(precision)}
                  </div>
                ) : null
              }
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke={stroke}
              strokeWidth={1.5}
              fill={`url(#spark-${label})`}
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * useRollingSeries: push latest snapshot into a fixed-length series.
 * Falls back to a deterministic synthetic warmup so the spark renders
 * even on the first paint before history accumulates.
 */
export function useRollingSeries(
  key: string,
  value: number | null,
  opts: { max?: number; warmupBase?: number; warmupAmp?: number } = {},
): SeriesPoint[] {
  const max = opts.max ?? 32;
  const ref = useRef<SeriesPoint[]>([]);

  // synthetic warmup so the chart isn't a single dot
  if (ref.current.length === 0) {
    const base = opts.warmupBase ?? value ?? 0;
    const amp = opts.warmupAmp ?? Math.max(Math.abs(base) * 0.05, 0.01);
    const now = Date.now();
    const seeded = Array.from({ length: max - 1 }, (_, i) => {
      const seed = hashStr(`${key}:${i}`);
      const noise = (seed / 2 ** 32) * 2 - 1;
      return { t: now - (max - 1 - i) * 30_000, v: base + noise * amp };
    });
    ref.current = seeded;
  }

  useEffect(() => {
    if (value == null || Number.isNaN(value)) return;
    const next = [...ref.current, { t: Date.now(), v: value }];
    if (next.length > max) next.splice(0, next.length - max);
    ref.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, max]);

  // Always include the current value as the trailing point
  return useMemo(() => {
    if (value == null || Number.isNaN(value)) return ref.current;
    const arr = [...ref.current];
    if (arr.length === 0 || arr[arr.length - 1].v !== value) {
      arr.push({ t: Date.now(), v: value });
    }
    return arr.slice(-max);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, max]);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
