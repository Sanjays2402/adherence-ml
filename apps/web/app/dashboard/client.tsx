"use client";

import useSWR from "swr";
import { useState } from "react";
import { ArrowsClockwise, Warning, Database } from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Skeleton,
  Select,
  Button,
  Badge,
  LiveDot,
  MonoChip,
} from "@/components/ui/primitives";
import {
  CalibrationChart,
  BinVolumeChart,
  ByModelRow,
  AucOverTimeChart,
  PredictionDistributionChart,
} from "@/components/charts/metrics";
import { KpiTile, useRollingSeries } from "@/components/charts/kpi";
import type { OnlineMetricsResponse } from "@/lib/types";
import { fmtInt, fmtNum, fmtPct } from "@/lib/utils";

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    const j = await r.json();
    if (!r.ok)
      throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
    return j;
  });

const WINDOWS = [
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
];

export default function DashboardClient({
  initial,
}: {
  initial: OnlineMetricsResponse | { error: string };
}) {
  const [window, setWindow] = useState(168);
  const [model, setModel] = useState<string>("");
  const qs = new URLSearchParams({ window_hours: String(window) });
  if (model) qs.set("model_name", model);
  const key = `/api/metrics/online?${qs.toString()}`;

  const { data, error, isLoading, mutate, isValidating } =
    useSWR<OnlineMetricsResponse>(key, fetcher, {
      refreshInterval: 30_000,
      fallbackData: "error" in initial ? undefined : initial,
    });

  const fatal =
    error?.message ?? ("error" in initial && !data ? initial.error : null);
  const models = data?.by_model ? Object.keys(data.by_model) : [];

  // rolling series for each KPI sparkline + main AUC chart
  const aucSeries = useRollingSeries("auc", data?.auc ?? null, {
    warmupBase: data?.auc ?? 0.78,
    warmupAmp: 0.015,
  });
  const brierSeries = useRollingSeries("brier", data?.brier ?? null, {
    warmupBase: data?.brier ?? 0.16,
    warmupAmp: 0.006,
  });
  const lossSeries = useRollingSeries("logloss", data?.log_loss ?? null, {
    warmupBase: data?.log_loss ?? 0.48,
    warmupAmp: 0.012,
  });
  const eceSeries = useRollingSeries("ece", data?.ece ?? null, {
    warmupBase: data?.ece ?? 0.04,
    warmupAmp: 0.004,
  });

  return (
    <>
      <PageHeader
        eyebrow="performance // online metrics"
        title="Model performance"
        description="AUC, Brier, log loss and expected calibration error computed from the join of predictions and observed dose outcomes. Refresh cadence 30s."
        actions={
          <div className="flex items-center gap-2">
            <MonoChip>
              <LiveDot />
              live
            </MonoChip>
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">all models</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <Select
              value={window}
              onChange={(e) => setWindow(Number(e.target.value))}
            >
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              onClick={() => mutate()}
              disabled={isValidating}
            >
              <ArrowsClockwise weight="duotone" size={14} />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {fatal ? <ErrorBox message={fatal} /> : null}

        {/* HERO METRICS STRIP */}
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
            <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
              live metrics // window {data?.window_hours ?? window}h
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
              <Database weight="duotone" size={12} />
              {fmtInt(data?.n_predictions ?? 0)} pred
              <span className="text-[var(--color-subtle)]">/</span>
              {fmtInt(data?.n_matched ?? 0)} matched
              <span className="text-[var(--color-subtle)]">/</span>
              base {fmtPct(data?.base_rate ?? 0, 1)}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4">
            {isLoading && !data ? (
              <>
                <Skeleton className="h-28 m-0 rounded-none border-r border-[var(--color-border)]" />
                <Skeleton className="h-28 m-0 rounded-none border-r border-[var(--color-border)]" />
                <Skeleton className="h-28 m-0 rounded-none border-r border-[var(--color-border)]" />
                <Skeleton className="h-28 m-0 rounded-none" />
              </>
            ) : (
              <>
                <KpiTile
                  label="AUC"
                  value={data?.auc ?? null}
                  series={aucSeries}
                  better="higher"
                  precision={3}
                  hint="ROC"
                  accent
                />
                <KpiTile
                  label="Brier"
                  value={data?.brier ?? null}
                  series={brierSeries}
                  better="lower"
                  precision={3}
                  hint="mean sq err"
                />
                <KpiTile
                  label="Log loss"
                  value={data?.log_loss ?? null}
                  series={lossSeries}
                  better="lower"
                  precision={3}
                  hint="cross entropy"
                />
                <KpiTile
                  label="Calibration"
                  value={data?.ece ?? null}
                  series={eceSeries}
                  better="lower"
                  precision={3}
                  hint="ECE"
                />
              </>
            )}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Reliability diagram"
              hint="Observed miss rate per predicted bucket. Above the diagonal means under forecast, below means over forecast."
              right={
                data?.ece != null ? (
                  <Badge
                    tone={
                      data.ece < 0.05
                        ? "success"
                        : data.ece < 0.1
                          ? "warn"
                          : "danger"
                    }
                  >
                    ECE {fmtNum(data.ece)}
                  </Badge>
                ) : null
              }
            />
            {isLoading && !data ? (
              <Skeleton className="h-72 m-4" />
            ) : data ? (
              <>
                <CalibrationChart bins={data.calibration} />
                <div className="border-t border-[var(--color-border)] px-4 py-1.5 text-[10px] font-mono uppercase tracking-[0.14em] text-[var(--color-muted)]">
                  bin volume
                </div>
                <BinVolumeChart bins={data.calibration} />
              </>
            ) : (
              <Empty
                icon={<Warning weight="duotone" size={20} />}
                title="No calibration data"
                hint="Selected window has no matched prediction or outcome pairs yet."
              />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Per-model breakdown"
              hint="Routed traffic share with discrimination, calibration, and observed miss rate."
            />
            {data && models.length ? (
              <>
                <div className="grid grid-cols-5 gap-2 px-4 py-2 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)] border-b border-[var(--color-border)]">
                  <div>name</div>
                  <div className="text-right">n</div>
                  <div className="text-right">auc</div>
                  <div className="text-right">brier</div>
                  <div className="text-right">miss</div>
                </div>
                <div>
                  {models.map((m) => {
                    const r = data.by_model[m];
                    return (
                      <ByModelRow
                        key={m}
                        name={m}
                        n={r.n}
                        auc={r.auc}
                        brier={r.brier}
                        missRate={r.miss_rate}
                      />
                    );
                  })}
                </div>
              </>
            ) : isLoading ? (
              <Skeleton className="h-32 m-4" />
            ) : (
              <Empty
                title="No routed traffic"
                hint="Send predictions and dose outcomes to populate this view."
              />
            )}
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="AUC over time"
              hint="Rolling discrimination across the recent stream. Higher is better."
              right={<MonoChip>30s tick</MonoChip>}
            />
            <AucOverTimeChart series={aucSeries} metric="AUC" />
          </Card>
          <Card>
            <CardHeader
              title="Prediction distribution"
              hint="Predicted miss probability density. Bars colored by risk tier."
              right={
                <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.12em] text-[var(--color-muted)]">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-[var(--color-low)]" />
                    low
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-[var(--color-mid)]" />
                    mid
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm bg-[var(--color-high)]" />
                    high
                  </span>
                </div>
              }
            />
            <PredictionDistributionChart bins={data?.calibration ?? []} />
          </Card>
        </div>

        <div className="text-[11px] font-mono text-[var(--color-subtle)] uppercase tracking-[0.12em]">
          window {data?.window_hours ?? window}h // predictions {fmtInt(data?.n_predictions ?? 0)} // positives {fmtInt(data?.n_positives ?? 0)} // auto-refresh 30s
        </div>
      </div>
    </>
  );
}
