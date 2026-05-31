"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";
import type { DosePrediction } from "@/lib/types";
import { fmtPct } from "@/lib/utils";

const HIGH = "var(--color-danger)";
const MID = "var(--color-warn)";
const LOW = "var(--color-success)";

function colorFor(tier: DosePrediction["risk_tier"]) {
  if (tier === "high") return HIGH;
  if (tier === "medium") return MID;
  return LOW;
}

export function RiskBarChart({
  predictions,
}: {
  predictions: DosePrediction[];
}) {
  if (predictions.length === 0) return null;
  const rows = predictions.map((p) => ({
    label: p.dose_id,
    pct: Number((p.miss_probability * 100).toFixed(1)),
    tier: p.risk_tier,
    iso: p.scheduled_at,
  }));
  const max = Math.max(100, Math.ceil(Math.max(...rows.map((r) => r.pct)) / 10) * 10);
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
          barCategoryGap="22%"
        >
          <CartesianGrid
            strokeDasharray="2 3"
            stroke="var(--color-border)"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-muted)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--color-border)" }}
            interval={0}
            height={28}
          />
          <YAxis
            domain={[0, max]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <ReferenceLine
            y={70}
            stroke={HIGH}
            strokeDasharray="3 3"
            strokeOpacity={0.55}
            label={{ value: "high 70%", position: "insideTopRight", fill: HIGH, fontSize: 10 }}
          />
          <ReferenceLine
            y={40}
            stroke={MID}
            strokeDasharray="3 3"
            strokeOpacity={0.55}
            label={{ value: "med 40%", position: "insideTopRight", fill: MID, fontSize: 10 }}
          />
          <Tooltip
            cursor={{ fill: "var(--color-fg)", fillOpacity: 0.04 }}
            contentStyle={{
              background: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value: number) => [fmtPct(Number(value) / 100), "miss probability"]}
            labelFormatter={(label) => `dose ${label}`}
          />
          <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
            {rows.map((r, i) => (
              <Cell key={i} fill={colorFor(r.tier)} fillOpacity={0.85} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
