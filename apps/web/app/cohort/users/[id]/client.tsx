"use client";

import { useState, useTransition } from "react";
import {
  ArrowsClockwise,
  ChartBar,
  Lightning,
  Bell,
  Warning,
  CheckCircle,
} from "@phosphor-icons/react";
import {
  Card,
  CardHeader,
  Stat,
  Empty,
  ErrorBox,
  Badge,
  Button,
  Select,
} from "@/components/ui/primitives";
import type {
  PredictResponse,
  ForecastResponse,
  DeliveryOut,
  DoseClass,
} from "@/lib/types";
import { fmtPct, fmtTime, fmtInt, riskColor } from "@/lib/utils";

type Maybe<T> = T | { error: string };

function isErr<T>(x: Maybe<T>): x is { error: string } {
  return Boolean(x && typeof x === "object" && "error" in x);
}

const HORIZONS = [3, 7, 14, 30];

function buildHistory(userId: string) {
  const out: Array<{
    user_id: string;
    dose_id: string;
    scheduled_at: string;
    taken_at: string | null;
    status: "taken" | "missed";
    dose_class: DoseClass;
    dose_strength_mg: number;
  }> = [];
  const now = new Date();
  now.setMinutes(0, 0, 0);
  for (let d = 14; d >= 1; d--) {
    for (const [idx, hour, klass, mg] of [
      [0, 8, "cardio", 10] as const,
      [1, 21, "psych", 25] as const,
    ]) {
      const sched = new Date(now);
      sched.setDate(sched.getDate() - d);
      sched.setHours(hour);
      const seed = (userId.charCodeAt(0) || 1) * 31 + d * 7 + idx;
      const missed = seed % 5 === 0;
      out.push({
        user_id: userId,
        dose_id: `${userId}-h${d}-${idx}`,
        scheduled_at: sched.toISOString(),
        taken_at: missed
          ? null
          : new Date(sched.getTime() + 10 * 60_000).toISOString(),
        status: missed ? "missed" : "taken",
        dose_class: klass,
        dose_strength_mg: mg,
      });
    }
  }
  return out;
}

export default function UserDetailClient({
  userId,
  initialPredict,
  initialForecast,
  initialDeliveries,
}: {
  userId: string;
  initialPredict: Maybe<PredictResponse>;
  initialForecast: Maybe<ForecastResponse>;
  initialDeliveries: Maybe<DeliveryOut[]>;
}) {
  const [forecast, setForecast] = useState<Maybe<ForecastResponse>>(
    initialForecast,
  );
  const [horizon, setHorizon] = useState(7);
  const [pending, startTransition] = useTransition();
  const [mutationError, setMutationError] = useState<string | null>(null);

  function recompute(nextHorizon: number) {
    setMutationError(null);
    setHorizon(nextHorizon);
    startTransition(async () => {
      try {
        const res = await fetch("/api/proxy/v1/forecast/user", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            history: buildHistory(userId),
            horizon_days: nextHorizon,
            bootstrap_iterations: 200,
            seed: 11,
          }),
        });
        const j = await res.json();
        if (!res.ok) {
          throw new Error(
            typeof j?.detail === "string" ? j.detail : `failed (${res.status})`,
          );
        }
        setForecast(j as ForecastResponse);
      } catch (err) {
        setMutationError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="p-6 space-y-6">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Stat
          label="Forecast adherence"
          value={
            isErr(forecast)
              ? "n/a"
              : fmtPct(forecast.overall_projected_adherence_rate)
          }
          sub={
            isErr(forecast)
              ? "forecast unavailable"
              : `90% CI ${fmtPct(forecast.overall_adherence_ci_low)} – ${fmtPct(forecast.overall_adherence_ci_high)}`
          }
        />
        <Stat
          label="Doses scored"
          value={isErr(forecast) ? "n/a" : fmtInt(forecast.n_doses_scored)}
          sub={isErr(forecast) ? undefined : `${forecast.horizon_days}d horizon`}
        />
        <Stat
          label="Next doses scored"
          value={
            isErr(initialPredict)
              ? "n/a"
              : fmtInt(initialPredict.predictions.length)
          }
          sub={
            isErr(initialPredict)
              ? "predict unavailable"
              : `model ${initialPredict.model_version}`
          }
        />
        <Stat
          label="Recent deliveries"
          value={
            isErr(initialDeliveries) ? "n/a" : fmtInt(initialDeliveries.length)
          }
          sub={
            isErr(initialDeliveries)
              ? "deliveries unavailable"
              : "last 20 actions"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Projected adherence"
            hint="POST /v1/forecast/user with this user's recent history."
            right={
              <div className="flex items-center gap-2">
                <Select
                  value={horizon}
                  onChange={(e) => recompute(Number(e.target.value))}
                  disabled={pending}
                >
                  {HORIZONS.map((h) => (
                    <option key={h} value={h}>
                      {h}d
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  onClick={() => recompute(horizon)}
                  disabled={pending}
                >
                  <ArrowsClockwise
                    weight="duotone"
                    size={14}
                    className={pending ? "animate-spin" : undefined}
                  />
                  Recompute
                </Button>
              </div>
            }
          />
          {mutationError ? (
            <div className="p-3">
              <ErrorBox message={mutationError} />
            </div>
          ) : null}
          {isErr(forecast) ? (
            <Empty
              icon={<Warning weight="duotone" size={20} />}
              title="Forecast failed"
              hint={forecast.error}
            />
          ) : forecast.by_day.length === 0 ? (
            <Empty
              icon={<ChartBar weight="duotone" size={20} />}
              title="No daily rows"
              hint="The forecast returned an empty schedule."
            />
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {forecast.by_day.map((d) => {
                const pct = d.projected_adherence_rate;
                return (
                  <div key={d.date} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-mono">{d.date}</div>
                      <div className="flex items-center gap-3 text-xs tabular-nums">
                        <span className="text-[var(--color-muted)]">
                          {fmtInt(d.n_doses)} doses
                        </span>
                        {d.high_risk_count > 0 ? (
                          <Badge tone="danger">
                            {d.high_risk_count} high
                          </Badge>
                        ) : null}
                        <span className="font-medium">{fmtPct(pct)}</span>
                      </div>
                    </div>
                    <div className="mt-1.5 h-1 rounded-full bg-[var(--color-border)] overflow-hidden">
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
                          background:
                            pct >= 0.9
                              ? "var(--color-success)"
                              : pct >= 0.7
                                ? "var(--color-warn)"
                                : "var(--color-danger)",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Next dose risk"
            hint="POST /v1/predict on the next 3 days of canonical schedule."
            right={
              isErr(initialPredict) ? null : (
                <Badge tone="neutral">
                  v{initialPredict.model_version}
                </Badge>
              )
            }
          />
          {isErr(initialPredict) ? (
            <Empty
              icon={<Warning weight="duotone" size={20} />}
              title="Predict failed"
              hint={initialPredict.error}
            />
          ) : initialPredict.predictions.length === 0 ? (
            <Empty
              icon={<Lightning weight="duotone" size={20} />}
              title="No predictions"
              hint="The model returned an empty list."
            />
          ) : (
            <div className="divide-y divide-[var(--color-border)] max-h-[420px] overflow-auto scrollbar-thin">
              {initialPredict.predictions.map((p) => (
                <div key={p.dose_id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-mono truncate">
                        {p.dose_id}
                      </div>
                      <div className="text-xs text-[var(--color-muted)] mt-0.5">
                        {fmtTime(p.scheduled_at)}
                        {p.dose_class ? ` · ${p.dose_class}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        tone={
                          p.risk_tier === "high"
                            ? "danger"
                            : p.risk_tier === "medium"
                              ? "warn"
                              : "success"
                        }
                      >
                        {p.risk_tier}
                      </Badge>
                      <span
                        className="text-sm font-medium tabular-nums"
                        style={{ color: riskColor(p.miss_probability) }}
                      >
                        {fmtPct(p.miss_probability)}
                      </span>
                    </div>
                  </div>
                  {p.reasons?.length ? (
                    <ul className="mt-1.5 space-y-0.5">
                      {p.reasons.slice(0, 3).map((r) => (
                        <li
                          key={r.feature}
                          className="text-xs text-[var(--color-fg)]/70 flex items-start gap-1.5"
                        >
                          <span className="text-[var(--color-subtle)]">·</span>
                          <span className="flex-1">{r.human}</span>
                          <span
                            className="tabular-nums font-mono"
                            style={{
                              color:
                                r.contribution > 0
                                  ? "var(--color-danger)"
                                  : "var(--color-success)",
                            }}
                          >
                            {r.contribution > 0 ? "+" : ""}
                            {r.contribution.toFixed(2)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent deliveries"
          hint="GET /v1/interventions/deliveries/{user}"
        />
        {isErr(initialDeliveries) ? (
          <Empty
            icon={<Warning weight="duotone" size={20} />}
            title="Deliveries failed"
            hint={initialDeliveries.error}
          />
        ) : initialDeliveries.length === 0 ? (
          <Empty
            icon={<Bell weight="duotone" size={20} />}
            title="No deliveries"
            hint="This user has no queued or sent interventions yet."
          />
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {initialDeliveries.map((d) => (
              <div
                key={d.id}
                className="px-4 py-2.5 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-mono truncate">{d.action}</div>
                    <Badge tone={d.state === "acted" ? "success" : "neutral"}>
                      {d.state}
                    </Badge>
                    <Badge tone="neutral">{d.channel}</Badge>
                  </div>
                  <div className="text-xs text-[var(--color-muted)] mt-0.5">
                    {fmtTime(d.created_at)}
                    {d.reason ? ` · ${d.reason}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 text-xs tabular-nums">
                  {d.acked_by ? (
                    <span className="text-[var(--color-success)] inline-flex items-center gap-1">
                      <CheckCircle weight="duotone" size={12} />
                      {d.acked_by}
                    </span>
                  ) : null}
                  <span className="text-[var(--color-muted)]">
                    score {fmtPct(d.score, 0)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
