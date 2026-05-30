"use client";

import useSWR from "swr";
import { useState } from "react";
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
import { ArrowsClockwise, Lightbulb, FunnelSimple } from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  ErrorBox,
  Skeleton,
  Empty,
  Badge,
  Button,
  Input,
} from "@/components/ui/primitives";
import type { ExplainGlobalResponse, ExplainSampleResponse } from "@/lib/types";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(async (r) => {
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
  return j;
});

function GlobalChart({ data }: { data: ExplainGlobalResponse }) {
  const rows = data.features.slice(0, 15).map((f) => ({
    feature: f.human,
    shap: Number(f.mean_abs_shap.toFixed(5)),
    rank: f.rank,
  }));
  return (
    <div className="h-[420px] px-2 pt-3 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart layout="vertical" data={rows} margin={{ left: 8, right: 16, top: 8, bottom: 4 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" horizontal={false} />
          <XAxis type="number" tick={{ fill: "var(--color-muted)", fontSize: 11 }} stroke="var(--color-border-strong)" />
          <YAxis
            type="category"
            dataKey="feature"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            stroke="var(--color-border-strong)"
            width={180}
          />
          <Tooltip
            cursor={{ fill: "var(--color-border)" }}
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v: number) => v.toFixed(5)}
          />
          <Bar dataKey="shap" radius={[0, 2, 2, 0]}>
            {rows.map((_, i) => (
              <Cell key={i} fill="var(--color-accent)" fillOpacity={0.7} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SampleRow({ row, idx }: { row: ExplainSampleResponse["rows"][number]; idx: number }) {
  const entries = Object.entries(row.shap_values)
    .map(([feature, sv]) => ({
      feature,
      shap: sv,
      value: row.feature_values[feature] ?? 0,
    }))
    .sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap))
    .slice(0, 8);
  const maxAbs = Math.max(...entries.map((e) => Math.abs(e.shap)), 1e-9);
  const p = row.miss_probability;
  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--color-border)]/20">
        <div className="text-sm">
          Sample {idx + 1}
          <span className="text-[var(--color-muted)] ml-2 text-xs">
            miss probability
          </span>
        </div>
        <Badge tone={p >= 0.7 ? "danger" : p >= 0.4 ? "warn" : "success"}>
          {fmtPct(p)}
        </Badge>
      </div>
      <div className="px-4 py-3 space-y-1.5">
        {entries.map((e) => {
          const pos = e.shap >= 0;
          const w = (Math.abs(e.shap) / maxAbs) * 100;
          return (
            <div key={e.feature} className="text-xs grid grid-cols-[1fr_2fr_auto] items-center gap-3">
              <div className="font-mono truncate text-[var(--color-muted)]" title={e.feature}>
                {e.feature}
              </div>
              <div className="relative h-2 bg-[var(--color-border)]/40 rounded">
                <div className="absolute top-0 bottom-0 left-1/2 w-px bg-[var(--color-border-strong)]" />
                <div
                  className={cn(
                    "absolute top-0 bottom-0 rounded",
                    pos ? "bg-[var(--color-danger)]/70" : "bg-[var(--color-success)]/70",
                  )}
                  style={{
                    width: `${w / 2}%`,
                    [pos ? "left" : "right"]: "50%",
                  }}
                />
              </div>
              <div className="tabular-nums text-right w-24">
                <span className={pos ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}>
                  {pos ? "+" : ""}{e.shap.toFixed(4)}
                </span>
                <span className="text-[var(--color-muted)] ml-1">({e.value.toFixed(2)})</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ExplainClient() {
  const [model, setModel] = useState("default");
  const [nSamples, setNSamples] = useState(5);

  const globalSWR = useSWR<ExplainGlobalResponse>(
    `/api/explain/global?model_name=${encodeURIComponent(model)}`,
    fetcher,
  );
  const sampleSWR = useSWR<ExplainSampleResponse>(
    `/api/explain/sample?model_name=${encodeURIComponent(model)}&n=${nSamples}`,
    fetcher,
  );

  return (
    <>
      <PageHeader
        title="Explainer"
        description="Global SHAP-based feature importance plus per-sample contributions. Positive contributions push the predicted miss probability up."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <FunnelSimple weight="duotone" size={14} /> model
            </div>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-32"
            />
            <Button
              variant="ghost"
              onClick={() => {
                globalSWR.mutate();
                sampleSWR.mutate();
              }}
            >
              <ArrowsClockwise weight="duotone" size={14} />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="p-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Global feature importance"
            hint="Mean absolute SHAP across a fresh synthetic sample."
            right={
              globalSWR.data ? (
                <Badge tone="accent">v{globalSWR.data.model_version}</Badge>
              ) : null
            }
          />
          {globalSWR.error ? (
            <div className="p-4">
              <ErrorBox message={globalSWR.error.message} />
            </div>
          ) : !globalSWR.data ? (
            <Skeleton className="h-[420px] m-4" />
          ) : globalSWR.data.features.length === 0 ? (
            <Empty title="No features" hint="Model returned an empty feature list." />
          ) : (
            <GlobalChart data={globalSWR.data} />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Per-sample contributions"
            hint="Top features pushing each prediction up (red) or down (green)."
            right={
              <select
                value={nSamples}
                onChange={(e) => setNSamples(Number(e.target.value))}
                className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs"
              >
                {[3, 5, 10, 15, 25].map((n) => (
                  <option key={n} value={n}>{n} samples</option>
                ))}
              </select>
            }
          />
          {sampleSWR.error ? (
            <div className="p-4">
              <ErrorBox message={sampleSWR.error.message} />
            </div>
          ) : !sampleSWR.data ? (
            <Skeleton className="h-96 m-4" />
          ) : sampleSWR.data.rows.length === 0 ? (
            <Empty
              icon={<Lightbulb weight="duotone" size={20} />}
              title="No samples"
            />
          ) : (
            <div className="max-h-[600px] overflow-y-auto scrollbar-thin">
              {sampleSWR.data.rows.map((r, i) => (
                <SampleRow key={i} row={r} idx={i} />
              ))}
            </div>
          )}
        </Card>
      </div>

      {globalSWR.data ? (
        <div className="px-6 pb-6 text-xs text-[var(--color-muted)]">
          Sample size {globalSWR.data.sample_size} doses. Showing top 15 of {globalSWR.data.features.length} features.
        </div>
      ) : null}
    </>
  );
}
