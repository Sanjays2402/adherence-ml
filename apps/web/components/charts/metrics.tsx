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
} from "recharts";
import type { CalibrationBin } from "@/lib/types";
import { fmtPct } from "@/lib/utils";

const TICK = { fill: "var(--color-muted)", fontSize: 11 };
const AXIS = { stroke: "var(--color-border-strong)" };

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs shadow-lg">
      <div className="text-[var(--color-muted)] mb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 tabular-nums">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: p.color }}
          />
          <span className="text-[var(--color-muted)]">{p.name}</span>
          <span className="ml-auto">{Number(p.value).toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}

export function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const data = bins
    .filter((b) => b.n > 0)
    .map((b) => ({
      mid: (b.p_lo + b.p_hi) / 2,
      predicted: b.mean_pred,
      observed: b.miss_rate,
      n: b.n,
    }));
  if (data.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-[var(--color-muted)]">
        No matched outcomes in this window yet.
      </div>
    );
  }
  return (
    <div className="h-72 px-2 pt-3 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" />
          <XAxis
            dataKey="mid"
            type="number"
            domain={[0, 1]}
            tickFormatter={(v) => v.toFixed(1)}
            tick={TICK}
            {...AXIS}
          />
          <YAxis
            type="number"
            domain={[0, 1]}
            tickFormatter={(v) => v.toFixed(1)}
            tick={TICK}
            {...AXIS}
            width={32}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ stroke: "var(--color-border-strong)" }}
          />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke="var(--color-subtle)"
            strokeDasharray="3 3"
          />
          <Line
            type="monotone"
            dataKey="predicted"
            name="predicted"
            stroke="var(--color-subtle)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="observed"
            name="observed"
            stroke="var(--color-accent)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--color-accent)" }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BinVolumeChart({ bins }: { bins: CalibrationBin[] }) {
  const data = bins.map((b, i) => ({
    name: `${(b.p_lo).toFixed(1)}-${b.p_hi.toFixed(1)}`,
    n: b.n,
    idx: i,
  }));
  return (
    <div className="h-40 px-2 pt-2 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="name" tick={{ ...TICK, fontSize: 10 }} {...AXIS} />
          <YAxis tick={TICK} {...AXIS} width={32} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-border)" }} />
          <Bar dataKey="n" name="doses" radius={[2, 2, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill="var(--color-accent)" fillOpacity={0.55} />
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
  return (
    <div className="grid grid-cols-5 items-center gap-2 px-4 py-2 text-sm border-b border-[var(--color-border)] last:border-b-0">
      <div className="font-mono text-xs truncate">{name}</div>
      <div className="tabular-nums text-right">{n}</div>
      <div className="tabular-nums text-right">{auc != null ? auc.toFixed(3) : "n/a"}</div>
      <div className="tabular-nums text-right">{brier.toFixed(3)}</div>
      <div className="tabular-nums text-right">{fmtPct(missRate)}</div>
    </div>
  );
}
