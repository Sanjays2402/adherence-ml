"use client";

import { useState } from "react";
import {
  Lightning,
  Timer,
  CheckCircle,
  Copy,
  Check,
  Pulse,
} from "@phosphor-icons/react";
import {
  Card,
  CardHeader,
  Button,
  Badge,
  Empty,
} from "@/components/ui/primitives";
import { RiskBarChart } from "@/components/charts/risk-bars";
import { cn, fmtPct, fmtTime } from "@/lib/utils";
import type { ShareRecord } from "@/lib/shares";

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function ShareView({ record }: { record: ShareRecord }) {
  const { result, rows, latency_ms, user_id, created_at } = record;
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked; ignore
    }
  }

  return (
    <>
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]/40">
        <div className="px-4 sm:px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Pulse weight="duotone" size={18} className="text-[var(--color-accent)] shrink-0" />
            <span className="text-[13px] font-semibold tracking-tight">adherence.ml</span>
            <span className="hidden sm:inline text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)] ml-2">
              shared result
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="neutral">id {record.id}</Badge>
            <Button type="button" variant="ghost" onClick={copyLink}>
              {copied ? (
                <Check weight="duotone" size={14} />
              ) : (
                <Copy weight="duotone" size={14} />
              )}
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      </header>

      <div className="p-4 sm:p-6 space-y-6">
        <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto] items-baseline">
          <div className="text-xs font-mono uppercase tracking-widest text-[var(--color-muted)]">
            user
          </div>
          <div className="text-base font-medium font-mono truncate">{user_id}</div>
          <div className="text-xs text-[var(--color-muted)] sm:text-right">
            shared {relTime(created_at)} {" "} via model {result.model_version}
            {latency_ms != null ? ` // ${latency_ms} ms` : ""}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader
              title="Schedule"
              hint={`${rows.length} dose${rows.length === 1 ? "" : "s"} scored`}
            />
            <div className="divide-y divide-[var(--color-border)]">
              {rows.map((r) => (
                <div
                  key={r.dose_id}
                  className="px-4 py-3 grid grid-cols-[1fr_auto] gap-2 items-center"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-mono font-medium truncate">
                      {r.dose_id}
                    </div>
                    <div className="text-xs text-[var(--color-muted)]">
                      {fmtTime(r.scheduled_at)} // {r.dose_class}
                    </div>
                  </div>
                  <div className="text-xs tabular-nums text-[var(--color-muted)]">
                    {r.dose_strength_mg} mg
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Predictions"
              hint={`model ${result.model_version}`}
              right={
                <div className="flex items-center gap-2">
                  {latency_ms != null ? (
                    <Badge tone="neutral">
                      <Timer weight="duotone" size={10} /> {latency_ms} ms
                    </Badge>
                  ) : null}
                  <Badge tone="success">
                    <CheckCircle weight="duotone" size={10} /> ok
                  </Badge>
                </div>
              }
            />
            {result.predictions.length > 0 ? (
              <div className="px-4 pt-3 pb-1 border-b border-[var(--color-border)]">
                <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)] mb-1">
                  miss probability by dose
                </div>
                <RiskBarChart predictions={result.predictions} />
              </div>
            ) : null}
            {result.predictions.length === 0 ? (
              <Empty
                icon={<Lightning weight="duotone" size={20} />}
                title="Empty response"
                hint="Model returned no predictions."
              />
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {result.predictions.map((p) => {
                  const tone =
                    p.risk_tier === "high"
                      ? "danger"
                      : p.risk_tier === "medium"
                        ? "warn"
                        : "success";
                  return (
                    <div key={p.dose_id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium font-mono truncate">
                            {p.dose_id}
                          </div>
                          <div className="text-xs text-[var(--color-muted)]">
                            {fmtTime(p.scheduled_at)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div
                            className={cn(
                              "text-base font-medium tabular-nums",
                              p.risk_tier === "high" && "text-[var(--color-danger)]",
                              p.risk_tier === "medium" && "text-[var(--color-warn)]",
                              p.risk_tier === "low" && "text-[var(--color-success)]",
                            )}
                          >
                            {fmtPct(p.miss_probability)}
                          </div>
                          <Badge tone={tone}>{p.risk_tier}</Badge>
                        </div>
                      </div>
                      {p.reasons.length > 0 ? (
                        <ul className="mt-2 space-y-1">
                          {p.reasons.map((r, i) => (
                            <li
                              key={i}
                              className="text-xs flex items-start gap-2"
                            >
                              <span
                                className={cn(
                                  "mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0",
                                  r.contribution >= 0
                                    ? "bg-[var(--color-danger)]"
                                    : "bg-[var(--color-success)]",
                                )}
                              />
                              <span className="text-[var(--color-fg)]/85">
                                {r.human}
                              </span>
                              <span className="ml-auto tabular-nums text-[var(--color-muted)]">
                                {r.contribution >= 0 ? "+" : ""}
                                {r.contribution.toFixed(3)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="text-center text-xs text-[var(--color-muted)]">
          Want to score your own schedule? {" "}
          <a href="/predict" className="text-[var(--color-accent)] hover:underline">
            Open the predictor
          </a>
        </div>
      </div>
    </>
  );
}
