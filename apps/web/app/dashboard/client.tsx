"use client";

import useSWR from "swr";
import { useState } from "react";
import { ArrowsClockwise, Warning } from "@phosphor-icons/react";
import { PageHeader, Card, CardHeader, Stat, Empty, ErrorBox, Skeleton, Select, Button, Badge } from "@/components/ui/primitives";
import {
  CalibrationChart,
  BinVolumeChart,
  ByModelRow,
} from "@/components/charts/metrics";
import type { OnlineMetricsResponse } from "@/lib/types";
import { fmtInt, fmtNum, fmtPct } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then(async (r) => {
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j?.detail === "string" ? j.detail : r.statusText);
  return j;
});

const WINDOWS = [
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
];

export default function DashboardClient({ initial }: { initial: OnlineMetricsResponse | { error: string } }) {
  const [window, setWindow] = useState(168);
  const [model, setModel] = useState<string>("");
  const qs = new URLSearchParams({ window_hours: String(window) });
  if (model) qs.set("model_name", model);
  const key = `/api/metrics/online?${qs.toString()}`;

  const { data, error, isLoading, mutate, isValidating } = useSWR<OnlineMetricsResponse>(
    key,
    fetcher,
    {
      refreshInterval: 30_000,
      fallbackData: "error" in initial ? undefined : initial,
    },
  );

  const fatal = error?.message ?? ("error" in initial && !data ? initial.error : null);

  const models = data?.by_model ? Object.keys(data.by_model) : [];

  return (
    <>
      <PageHeader
        title="Model performance"
        description="Live AUC, Brier and calibration computed from the join of predictions and reported dose outcomes."
        actions={
          <div className="flex items-center gap-2">
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">All models</option>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
            <Select value={window} onChange={(e) => setWindow(Number(e.target.value))}>
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>{w.label}</option>
              ))}
            </Select>
            <Button variant="ghost" onClick={() => mutate()} disabled={isValidating}>
              <ArrowsClockwise weight="duotone" size={14} />
              Refresh
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {fatal ? (
          <ErrorBox message={fatal} />
        ) : null}

        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          {isLoading && !data ? (
            <>
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </>
          ) : data ? (
            <>
              <Stat
                label="AUC"
                value={fmtNum(data.auc)}
                sub={`${fmtInt(data.n_matched)} matched`}
              />
              <Stat
                label="Brier"
                value={fmtNum(data.brier)}
                sub={`log loss ${fmtNum(data.log_loss)}`}
              />
              <Stat
                label="ECE"
                value={fmtNum(data.ece)}
                sub="expected calibration error"
              />
              <Stat
                label="Base rate"
                value={fmtPct(data.base_rate)}
                sub={`${fmtInt(data.n_positives)} positives`}
              />
            </>
          ) : null}
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Calibration"
              hint="Diagonal is perfect. Observed line above the dotted predicted line means the model is under-forecasting misses."
              right={
                data?.ece != null ? (
                  <Badge tone={data.ece < 0.05 ? "success" : data.ece < 0.1 ? "warn" : "danger"}>
                    ECE {fmtNum(data.ece)}
                  </Badge>
                ) : null
              }
            />
            {isLoading && !data ? (
              <Skeleton className="h-72 m-4" />
            ) : data && data.calibration.length ? (
              <>
                <CalibrationChart bins={data.calibration} />
                <div className="border-t border-[var(--color-border)] px-4 py-2 text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
                  Bin volume
                </div>
                <BinVolumeChart bins={data.calibration} />
              </>
            ) : (
              <Empty
                icon={<Warning weight="duotone" size={20} />}
                title="No calibration data"
                hint="The selected window has no matched (prediction, outcome) pairs yet."
              />
            )}
          </Card>

          <Card>
            <CardHeader title="By model" hint="One row per scored model in window." />
            {data && models.length ? (
              <>
                <div className="grid grid-cols-5 gap-2 px-4 py-2 text-[10px] uppercase tracking-wider text-[var(--color-muted)] border-b border-[var(--color-border)]">
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
              <Empty title="No model traffic" hint="Send predictions and dose outcomes to populate this view." />
            )}
          </Card>
        </div>

        <div className="text-xs text-[var(--color-muted)]">
          Window: {data?.window_hours ?? window}h. Predictions seen: {fmtInt(data?.n_predictions ?? 0)}.
          Auto-refreshes every 30s.
        </div>
      </div>
    </>
  );
}
