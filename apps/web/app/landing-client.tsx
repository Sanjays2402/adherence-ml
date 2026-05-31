"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Pulse,
  Lightning,
  Heartbeat,
  Brain,
  Pill,
  ArrowRight,
  Spinner,
  CheckCircle,
  ChartLineUp,
  ShieldCheck,
  Clock,
  Stack,
} from "@phosphor-icons/react";
import type { PredictResponse, DoseClass, RiskTier } from "@/lib/types";
import { fmtPct, cn } from "@/lib/utils";

type Sample = {
  id: string;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ size?: number; weight?: "duotone"; className?: string }>;
  userId: string;
  doses: { dose_id: string; offset_h: number; dose_class: DoseClass; dose_strength_mg: number }[];
};

const SAMPLES: Sample[] = [
  {
    id: "cardio-elderly",
    title: "Cardiac patient, late-day doses",
    blurb:
      "78-year-old on a beta blocker plus statin. Evening doses historically slip more often than morning ones.",
    icon: Heartbeat,
    userId: "demo-cardio-001",
    doses: [
      { dose_id: "morning-bb", offset_h: 1, dose_class: "cardio", dose_strength_mg: 25 },
      { dose_id: "evening-statin", offset_h: 11, dose_class: "cardio", dose_strength_mg: 40 },
      { dose_id: "bedtime-bb", offset_h: 14, dose_class: "cardio", dose_strength_mg: 25 },
    ],
  },
  {
    id: "psych-young",
    title: "Psych regimen, irregular schedule",
    blurb:
      "Young adult on an SSRI plus PRN anxiolytic. Weekend doses and overnight gaps drive elevated risk.",
    icon: Brain,
    userId: "demo-psych-002",
    doses: [
      { dose_id: "ssri-am", offset_h: 2, dose_class: "psych", dose_strength_mg: 20 },
      { dose_id: "prn-eve", offset_h: 9, dose_class: "psych", dose_strength_mg: 0.5 },
      { dose_id: "ssri-overnight", offset_h: 20, dose_class: "psych", dose_strength_mg: 20 },
    ],
  },
  {
    id: "endo-poly",
    title: "Diabetic polypharmacy",
    blurb:
      "Type 2 diabetic on metformin, a GLP-1, and a supplement. High dose count compounds miss probability.",
    icon: Pill,
    userId: "demo-endo-003",
    doses: [
      { dose_id: "metformin-am", offset_h: 1, dose_class: "endocrine", dose_strength_mg: 1000 },
      { dose_id: "glp1-weekly", offset_h: 6, dose_class: "endocrine", dose_strength_mg: 1 },
      { dose_id: "metformin-pm", offset_h: 13, dose_class: "endocrine", dose_strength_mg: 1000 },
      { dose_id: "vit-d", offset_h: 18, dose_class: "supplement", dose_strength_mg: 25 },
    ],
  },
];

function isoFromOffset(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

function tierColor(tier: RiskTier) {
  if (tier === "high") return "text-[var(--color-high)] bg-[var(--color-high)]/10 border-[var(--color-high)]/30";
  if (tier === "medium") return "text-[var(--color-mid)] bg-[var(--color-mid)]/10 border-[var(--color-mid)]/30";
  return "text-[var(--color-low)] bg-[var(--color-low)]/10 border-[var(--color-low)]/30";
}

export default function LandingClient() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [result, setResult] = useState<PredictResponse | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runSample(sample: Sample) {
    setActiveId(sample.id);
    setLoadingId(sample.id);
    setResult(null);
    setError(null);
    setLatencyMs(null);
    const body = {
      user_id: sample.userId,
      doses: sample.doses.map((d) => ({
        dose_id: d.dose_id,
        scheduled_at: isoFromOffset(d.offset_h),
        dose_class: d.dose_class,
        dose_strength_mg: d.dose_strength_mg,
      })),
      top_k_reasons: 3,
    };
    const t0 = performance.now();
    try {
      const res = await fetch("/api/proxy/v1/predict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.detail ?? `Request failed (${res.status})`);
      } else {
        setResult(json as PredictResponse);
        setLatencyMs(Math.round(performance.now() - t0));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="border-b border-[var(--color-border)] bg-gradient-to-b from-[var(--color-surface)]/40 to-transparent">
        <div className="mx-auto max-w-5xl px-6 py-16 md:py-24">
          <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
            <Pulse weight="duotone" size={14} className="text-[var(--color-accent)]" />
            adherence.ml / live demo
          </div>
          <h1 className="mt-4 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Predict the next missed dose
            <span className="text-[var(--color-muted)]"> before it happens.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base md:text-lg text-[var(--color-muted)] leading-relaxed">
            A calibrated XGBoost plus LightGBM ensemble scores upcoming doses for miss
            probability, ranks the highest-risk ones, and explains why with SHAP
            attributions. Pick a sample patient below and see a real prediction in under
            a second.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="#try"
              className="inline-flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-black hover:opacity-90 transition"
            >
              <Lightning weight="duotone" size={16} />
              Try a sample
            </a>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-4 py-2.5 text-sm hover:bg-[var(--color-surface)] transition"
            >
              View live metrics
              <ArrowRight size={14} />
            </Link>
          </div>

          {/* Feature strip */}
          <div className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                icon: ChartLineUp,
                label: "Calibrated probabilities",
                hint: "Isotonic regression on a held-out fold",
              },
              {
                icon: ShieldCheck,
                label: "Per-dose explanations",
                hint: "SHAP reason codes returned at predict time",
              },
              {
                icon: Stack,
                label: "Production wired",
                hint: "Audit log, drift checks, intervention queue",
              },
            ].map((f) => (
              <div
                key={f.label}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <f.icon weight="duotone" size={16} className="text-[var(--color-accent)]" />
                  <div className="text-sm font-medium">{f.label}</div>
                </div>
                <div className="mt-1 text-xs text-[var(--color-muted)]">{f.hint}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Try-it */}
      <section id="try" className="mx-auto max-w-5xl px-6 py-14">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
              Step 1
            </div>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              Pick a patient scenario
            </h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Each card posts to <code className="font-mono text-[var(--color-fg)]">/v1/predict</code> with a
              realistic upcoming dose schedule.
            </p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3">
          {SAMPLES.map((s) => {
            const isActive = activeId === s.id;
            const isLoading = loadingId === s.id;
            return (
              <button
                key={s.id}
                onClick={() => runSample(s)}
                disabled={loadingId !== null}
                className={cn(
                  "group text-left rounded-lg border p-4 transition focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40",
                  isActive
                    ? "border-[var(--color-accent)]/60 bg-[var(--color-accent)]/5"
                    : "border-[var(--color-border)] bg-[var(--color-surface)]/40 hover:border-[var(--color-border)]/80 hover:bg-[var(--color-surface)]/70",
                  loadingId !== null && !isLoading && "opacity-60",
                )}
              >
                <div className="flex items-center justify-between">
                  <s.icon weight="duotone" size={20} className="text-[var(--color-accent)]" />
                  {isLoading ? (
                    <Spinner size={14} className="animate-spin text-[var(--color-muted)]" />
                  ) : isActive ? (
                    <CheckCircle weight="duotone" size={14} className="text-[var(--color-low)]" />
                  ) : (
                    <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)] group-hover:text-[var(--color-fg)]">
                      Run
                    </span>
                  )}
                </div>
                <div className="mt-3 text-sm font-medium leading-snug">{s.title}</div>
                <div className="mt-1 text-xs text-[var(--color-muted)] leading-relaxed">
                  {s.blurb}
                </div>
                <div className="mt-3 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)]">
                  <Clock size={11} /> {s.doses.length} upcoming doses
                </div>
              </button>
            );
          })}
        </div>

        {/* Result panel */}
        <div className="mt-8">
          <div className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
            Step 2
          </div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">Live model output</h2>

          <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/40 p-5 min-h-[220px]">
            {!activeId && !result && !error && (
              <div className="flex h-[180px] items-center justify-center text-sm text-[var(--color-muted)]">
                Pick a scenario above to score it against the live model.
              </div>
            )}

            {loadingId && (
              <div className="space-y-3">
                <div className="h-4 w-1/3 rounded bg-[var(--color-border)]/40 animate-pulse" />
                <div className="h-3 w-1/2 rounded bg-[var(--color-border)]/30 animate-pulse" />
                <div className="mt-4 space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="h-10 rounded bg-[var(--color-border)]/20 animate-pulse"
                    />
                  ))}
                </div>
              </div>
            )}

            {error && !loadingId && (
              <div className="rounded-md border border-[var(--color-high)]/30 bg-[var(--color-high)]/5 px-3 py-2 text-sm text-[var(--color-high)]">
                {error}
              </div>
            )}

            {result && !loadingId && (
              <ResultView result={result} latencyMs={latencyMs} />
            )}
          </div>
        </div>

        {/* Footer CTA */}
        <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-6">
          <div className="text-sm text-[var(--color-muted)]">
            Want the full surface? Browse the cohort, the SHAP explainer, or the intervention queue.
          </div>
          <div className="flex gap-2">
            <Link
              href="/cohort"
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface)]"
            >
              Cohort
            </Link>
            <Link
              href="/explain"
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface)]"
            >
              Explainer
            </Link>
            <Link
              href="/interventions"
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface)]"
            >
              Interventions
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function ResultView({
  result,
  latencyMs,
}: {
  result: PredictResponse;
  latencyMs: number | null;
}) {
  const sorted = [...result.predictions].sort(
    (a, b) => b.miss_probability - a.miss_probability,
  );
  const top = sorted[0];

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
            Patient
          </div>
          <div className="mt-0.5 text-sm font-medium">{result.user_id}</div>
        </div>
        <div className="flex items-center gap-4 text-xs text-[var(--color-muted)]">
          <span>
            model{" "}
            <span className="font-mono text-[var(--color-fg)]">{result.model_version}</span>
          </span>
          {latencyMs != null && (
            <span>
              latency{" "}
              <span className="font-mono text-[var(--color-fg)]">{latencyMs} ms</span>
            </span>
          )}
        </div>
      </div>

      {/* Headline risk */}
      <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs text-[var(--color-muted)]">Highest-risk upcoming dose</div>
            <div className="mt-0.5 text-sm font-medium font-mono">{top.dose_id}</div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tabular-nums">
              {fmtPct(top.miss_probability, 1)}
            </div>
            <div className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
              miss probability
            </div>
          </div>
        </div>
        {top.reasons && top.reasons.length > 0 && (
          <div className="mt-4 space-y-1.5">
            <div className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
              Why
            </div>
            {top.reasons.slice(0, 3).map((r) => (
              <div key={r.feature} className="flex items-center gap-3 text-xs">
                <div
                  className={cn(
                    "h-1.5 rounded-full",
                    r.contribution >= 0
                      ? "bg-[var(--color-high)]"
                      : "bg-[var(--color-low)]",
                  )}
                  style={{
                    width: `${Math.min(100, Math.abs(r.contribution) * 100 + 6)}px`,
                  }}
                />
                <span className="text-[var(--color-fg)]">{r.human}</span>
                <span className="ml-auto font-mono text-[var(--color-muted)]">
                  {r.contribution >= 0 ? "+" : ""}
                  {r.contribution.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* All doses */}
      <div className="mt-4">
        <div className="text-[11px] font-mono uppercase tracking-widest text-[var(--color-muted)] mb-2">
          All upcoming doses ({result.predictions.length})
        </div>
        <div className="space-y-1.5">
          {sorted.map((p) => (
            <div
              key={p.dose_id}
              className="flex items-center gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-2"
            >
              <span className="text-xs font-mono text-[var(--color-muted)] w-32 truncate">
                {p.dose_id}
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-[var(--color-border)]/40 overflow-hidden">
                <div
                  className={cn(
                    "h-full",
                    p.risk_tier === "high"
                      ? "bg-[var(--color-high)]"
                      : p.risk_tier === "medium"
                        ? "bg-[var(--color-mid)]"
                        : "bg-[var(--color-low)]",
                  )}
                  style={{ width: `${Math.round(p.miss_probability * 100)}%` }}
                />
              </div>
              <span
                className={cn(
                  "text-[10px] font-mono uppercase tracking-widest rounded px-1.5 py-0.5 border",
                  tierColor(p.risk_tier),
                )}
              >
                {p.risk_tier}
              </span>
              <span className="text-xs font-mono tabular-nums w-14 text-right">
                {fmtPct(p.miss_probability, 1)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
