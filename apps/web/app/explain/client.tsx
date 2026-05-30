"use client";

import useSWR from "swr";
import { useMemo, useState } from "react";
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
  MonoChip,
  RiskDot,
} from "@/components/ui/primitives";
import { ShapWaterfall, ShapLegend, ContributionBars } from "@/components/charts/shap";
import type {
  ExplainGlobalResponse,
  ExplainSampleResponse,
  ExplainSampleRow,
} from "@/lib/types";
import { cn, fmtPct, riskFromProb, riskRailClass } from "@/lib/utils";

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    const j = await r.json();
    if (!r.ok)
      throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
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
        <BarChart
          layout="vertical"
          data={rows}
          margin={{ left: 8, right: 16, top: 8, bottom: 4 }}
        >
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            stroke="var(--color-border-strong)"
            tickFormatter={(v) => Number(v).toFixed(4)}
          />
          <YAxis
            type="category"
            dataKey="feature"
            tick={{ fill: "var(--color-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}
            stroke="var(--color-border-strong)"
            width={200}
          />
          <Tooltip
            cursor={{ fill: "var(--color-border)" }}
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
            formatter={(v: number) => v.toFixed(5)}
          />
          <Bar dataKey="shap" radius={[0, 2, 2, 0]}>
            {rows.map((_, i) => (
              <Cell key={i} fill="var(--color-accent)" fillOpacity={0.75} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ExplainClient() {
  const [model, setModel] = useState("default");
  const [nSamples, setNSamples] = useState(10);
  const [selected, setSelected] = useState(0);

  const globalSWR = useSWR<ExplainGlobalResponse>(
    `/api/explain/global?model_name=${encodeURIComponent(model)}`,
    fetcher,
  );
  const sampleSWR = useSWR<ExplainSampleResponse>(
    `/api/explain/sample?model_name=${encodeURIComponent(model)}&n=${nSamples}`,
    fetcher,
  );

  const rows = sampleSWR.data?.rows ?? [];
  const active: ExplainSampleRow | undefined = rows[selected];

  const baseRate = useMemo(() => {
    if (!rows.length) return 0.18;
    const mean =
      rows.reduce((acc, r) => acc + r.miss_probability, 0) / rows.length;
    // proxy for population base rate; clamp to a sane range
    return Math.min(0.6, Math.max(0.05, mean));
  }, [rows]);

  return (
    <>
      <PageHeader
        eyebrow="explainer // shap"
        title="Prediction explainer"
        description="SHAP attributions for the served model. Pick a scored dose on the left to see which features pushed its predicted miss probability up or down."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
              <FunnelSimple weight="duotone" size={12} /> model
            </div>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-36"
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

      <div className="p-6 space-y-6">
        {/* SIGNATURE: waterfall flanked by sample picker */}
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <Card>
            <CardHeader
              title="Sample doses"
              hint="Sorted by miss probability."
              right={
                <select
                  value={nSamples}
                  onChange={(e) => {
                    setNSamples(Number(e.target.value));
                    setSelected(0);
                  }}
                  className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs font-mono"
                >
                  {[5, 10, 15, 25, 50].map((n) => (
                    <option key={n} value={n}>
                      n={n}
                    </option>
                  ))}
                </select>
              }
            />
            {sampleSWR.error ? (
              <div className="p-4">
                <ErrorBox message={sampleSWR.error.message} />
              </div>
            ) : !sampleSWR.data ? (
              <div className="p-3 space-y-2">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : rows.length === 0 ? (
              <Empty title="No samples" />
            ) : (
              <div className="max-h-[600px] overflow-y-auto scrollbar-thin">
                {[...rows]
                  .map((r, i) => ({ r, i }))
                  .sort((a, b) => b.r.miss_probability - a.r.miss_probability)
                  .map(({ r, i }) => {
                    const tier = riskFromProb(r.miss_probability);
                    const active = i === selected;
                    return (
                      <button
                        key={i}
                        onClick={() => setSelected(i)}
                        className={cn(
                          "w-full text-left px-3 py-2 border-b border-[var(--color-border)] last:border-b-0 flex items-center gap-2 transition-colors",
                          riskRailClass(r.miss_probability),
                          active
                            ? "bg-[var(--color-accent-soft)]"
                            : "hover:bg-[var(--color-border)]/30",
                        )}
                      >
                        <RiskDot tier={tier} />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-mono">
                            sample {String(i + 1).padStart(2, "0")}
                          </div>
                          <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)]">
                            {tier} risk
                          </div>
                        </div>
                        <div className="text-sm font-mono tabular-nums">
                          {fmtPct(r.miss_probability, 0)}
                        </div>
                      </button>
                    );
                  })}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="SHAP waterfall"
              hint="Cumulative path from base rate to final prediction. Red bars increase predicted miss probability; emerald bars decrease it."
              right={
                <div className="flex items-center gap-2">
                  {active ? (
                    <Badge
                      tone={
                        active.miss_probability >= 0.7
                          ? "danger"
                          : active.miss_probability >= 0.4
                            ? "warn"
                            : "success"
                      }
                    >
                      p {fmtPct(active.miss_probability)}
                    </Badge>
                  ) : null}
                  <ShapLegend />
                </div>
              }
            />
            {!sampleSWR.data ? (
              <Skeleton className="h-[480px] m-4" />
            ) : !active ? (
              <Empty
                icon={<Lightbulb weight="duotone" size={20} />}
                title="Pick a sample"
              />
            ) : (
              <>
                <ShapWaterfall row={active} baseRate={baseRate} topK={12} />
                <div className="border-t border-[var(--color-border)] px-4 py-3 grid gap-4 md:grid-cols-3">
                  <Stat label="base rate" value={fmtPct(baseRate)} />
                  <Stat label="final p(miss)" value={fmtPct(active.miss_probability)} />
                  <Stat
                    label="net shap"
                    value={Object.values(active.shap_values)
                      .reduce((a, b) => a + b, 0)
                      .toFixed(4)}
                  />
                </div>
              </>
            )}
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Global feature importance"
              hint="Mean absolute SHAP over the latest sample window."
              right={
                globalSWR.data ? (
                  <MonoChip>v{globalSWR.data.model_version}</MonoChip>
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
              title="Top contributions"
              hint="Top features for the selected sample, signed and ranked."
            />
            {!active ? (
              <Empty title="Pick a sample" />
            ) : (
              <div className="p-4">
                <ContributionBars row={active} topK={10} />
              </div>
            )}
          </Card>
        </div>

        {globalSWR.data ? (
          <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--color-subtle)]">
            sample size {globalSWR.data.sample_size} doses // showing top 15 of {globalSWR.data.features.length} features
          </div>
        ) : null}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
        {label}
      </div>
      <div className="mt-0.5 text-base font-mono tabular-nums">{value}</div>
    </div>
  );
}
