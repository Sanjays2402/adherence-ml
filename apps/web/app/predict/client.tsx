"use client";

import { useState } from "react";
import {
  Lightning,
  Plus,
  Trash,
  Spinner,
  CheckCircle,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Button,
  Input,
  Select,
  ErrorBox,
  Empty,
  Badge,
} from "@/components/ui/primitives";
import type { PredictResponse, DoseClass } from "@/lib/types";
import { fmtPct, fmtTime, cn } from "@/lib/utils";

const CLASSES: DoseClass[] = [
  "cardio", "neuro", "endocrine", "psych", "antibiotic", "supplement", "other",
];

interface Row {
  dose_id: string;
  scheduled_at: string;
  dose_class: DoseClass;
  dose_strength_mg: number;
}

function nowPlus(hours: number) {
  const d = new Date(Date.now() + hours * 3600_000);
  // local datetime-local input format
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const defaultRows = (): Row[] => [
  { dose_id: "d1", scheduled_at: nowPlus(2), dose_class: "cardio", dose_strength_mg: 10 },
  { dose_id: "d2", scheduled_at: nowPlus(10), dose_class: "psych", dose_strength_mg: 25 },
  { dose_id: "d3", scheduled_at: nowPlus(22), dose_class: "endocrine", dose_strength_mg: 500 },
];

export default function PredictClient() {
  const [userId, setUserId] = useState("demo-user-001");
  const [rows, setRows] = useState<Row[]>(defaultRows());
  const [topK, setTopK] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PredictResponse | null>(null);

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function add() {
    setRows((rs) => [
      ...rs,
      {
        dose_id: `d${rs.length + 1}`,
        scheduled_at: nowPlus(rs.length * 6 + 2),
        dose_class: "other",
        dose_strength_mg: 0,
      },
    ]);
  }

  function remove(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const payload = {
        user_id: userId.trim(),
        top_k_reasons: topK,
        schedule: rows.map((r) => ({
          dose_id: r.dose_id,
          scheduled_at: new Date(r.scheduled_at).toISOString(),
          dose_class: r.dose_class,
          dose_strength_mg: Number(r.dose_strength_mg) || 0,
        })),
      };
      const res = await fetch("/api/proxy/v1/predict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.detail === "string" ? data.detail : `request failed (${res.status})`);
      }
      setResult(data as PredictResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="predict // live scoring"
        title="Inline prediction"
        description="POST /v1/predict against the served model. Use to spot-check feature wiring, calibration on edge users, or to reproduce an audit row."
      />

      <div className="p-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Request" hint="POST /v1/predict" />
          <form onSubmit={submit} className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <div className="text-xs text-[var(--color-muted)]">User ID</div>
                <Input value={userId} onChange={(e) => setUserId(e.target.value)} required />
              </label>
              <label className="space-y-1">
                <div className="text-xs text-[var(--color-muted)]">Top reasons</div>
                <Select value={topK} onChange={(e) => setTopK(Number(e.target.value))}>
                  {[0, 1, 3, 5, 10].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </Select>
              </label>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  Schedule ({rows.length})
                </div>
                <Button type="button" variant="ghost" onClick={add}>
                  <Plus weight="duotone" size={14} /> Add dose
                </Button>
              </div>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_1.4fr_1fr_0.8fr_auto] gap-2 items-center"
                  >
                    <Input
                      value={r.dose_id}
                      onChange={(e) => update(i, { dose_id: e.target.value })}
                      placeholder="dose id"
                      required
                    />
                    <Input
                      type="datetime-local"
                      value={r.scheduled_at}
                      onChange={(e) => update(i, { scheduled_at: e.target.value })}
                      required
                    />
                    <Select
                      value={r.dose_class}
                      onChange={(e) => update(i, { dose_class: e.target.value as DoseClass })}
                    >
                      {CLASSES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </Select>
                    <Input
                      type="number"
                      step="0.1"
                      value={r.dose_strength_mg}
                      onChange={(e) =>
                        update(i, { dose_strength_mg: Number(e.target.value) })
                      }
                      placeholder="mg"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => remove(i)}
                      disabled={rows.length === 1}
                      aria-label="remove"
                    >
                      <Trash weight="duotone" size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)]">
              <div className="text-xs text-[var(--color-muted)]">
                {rows.length} dose{rows.length === 1 ? "" : "s"} queued
              </div>
              <Button type="submit" disabled={submitting || rows.length === 0}>
                {submitting ? (
                  <Spinner weight="duotone" size={14} className="animate-spin" />
                ) : (
                  <Lightning weight="duotone" size={14} />
                )}
                {submitting ? "Scoring" : "Run prediction"}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Response"
            hint={result ? `model ${result.model_version}` : "Submit the form to see scored doses."}
            right={result ? <Badge tone="success"><CheckCircle weight="duotone" size={10} /> ok</Badge> : null}
          />
          {error ? (
            <div className="p-4"><ErrorBox message={error} /></div>
          ) : !result ? (
            <Empty
              icon={<Lightning weight="duotone" size={20} />}
              title="No prediction yet"
              hint="The form on the left posts to /v1/predict via the server-side proxy."
            />
          ) : result.predictions.length === 0 ? (
            <Empty title="Empty response" hint="Model returned no predictions." />
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {result.predictions.map((p) => {
                const tone = p.risk_tier === "high" ? "danger" : p.risk_tier === "medium" ? "warn" : "success";
                return (
                  <div key={p.dose_id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium font-mono truncate">{p.dose_id}</div>
                        <div className="text-xs text-[var(--color-muted)]">{fmtTime(p.scheduled_at)}</div>
                      </div>
                      <div className="text-right">
                        <div className={cn(
                          "text-base font-medium tabular-nums",
                          p.risk_tier === "high" && "text-[var(--color-danger)]",
                          p.risk_tier === "medium" && "text-[var(--color-warn)]",
                          p.risk_tier === "low" && "text-[var(--color-success)]",
                        )}>
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
                            <span className={cn(
                              "mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0",
                              r.contribution >= 0 ? "bg-[var(--color-danger)]" : "bg-[var(--color-success)]",
                            )} />
                            <span className="text-[var(--color-fg)]/85">{r.human}</span>
                            <span className="ml-auto tabular-nums text-[var(--color-muted)]">
                              {r.contribution >= 0 ? "+" : ""}{r.contribution.toFixed(3)}
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
    </>
  );
}
