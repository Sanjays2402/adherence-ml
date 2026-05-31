import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import {
  ArrowRight,
  Calendar,
  ClockCounterClockwise,
  IdentificationCard,
  Pulse,
  Tag,
  Timer,
} from "@phosphor-icons/react/dist/ssr";
import { getRun, type RunRecord } from "@/lib/runs-store";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const rec = await getRun(id);
  if (!rec) {
    return { title: "Run not found // adherence.ml" };
  }
  return {
    title: `${rec.title} // adherence.ml`,
    description: rec.summary || `Shared ${rec.kind} run from adherence.ml`,
    openGraph: {
      title: rec.title,
      description: rec.summary || `Shared ${rec.kind} run from adherence.ml`,
      type: "article",
    },
  };
}

async function fullUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function fmtFull(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

interface PredictPayload {
  request?: {
    user_id?: string;
    schedule?: Array<{ dose_id: string; scheduled_at: string; dose_class?: string; dose_strength_mg?: number }>;
    top_k_reasons?: number;
  };
  response?: {
    user_id?: string;
    model_version?: string;
    predictions?: Array<{
      dose_id: string;
      scheduled_at: string;
      miss_probability: number;
      risk_tier: string;
      reasons?: Array<{ feature: string; contribution: number; human: string }>;
    }>;
  };
}

function PredictResult({ payload }: { payload: PredictPayload }) {
  const preds = payload.response?.predictions ?? [];
  if (preds.length === 0) return null;
  return (
    <div className="space-y-4">
      <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-muted)]">
        {preds.length} dose{preds.length === 1 ? "" : "s"} scored
        {payload.response?.model_version ? ` // model ${payload.response.model_version}` : ""}
      </div>
      <div className="border border-[var(--color-border)] rounded-md overflow-hidden">
        <div className="grid grid-cols-[1fr_140px_120px_100px] text-[10px] font-mono uppercase tracking-wider bg-[var(--color-surface)]/50 px-3 py-2 border-b border-[var(--color-border)] text-[var(--color-muted)]">
          <div>Dose</div>
          <div>Scheduled</div>
          <div>Miss prob</div>
          <div>Tier</div>
        </div>
        {preds.map((p, i) => (
          <div
            key={`${p.dose_id}-${i}`}
            className="grid grid-cols-[1fr_140px_120px_100px] items-center px-3 py-2 border-b border-[var(--color-border)] last:border-b-0 text-[12px] font-mono"
          >
            <div className="truncate">{p.dose_id}</div>
            <div className="text-[var(--color-muted)] truncate">
              {new Date(p.scheduled_at).toISOString().slice(5, 16).replace("T", " ")}
            </div>
            <div className="tabular-nums">{(p.miss_probability * 100).toFixed(1)}%</div>
            <div>
              <span
                className={
                  "inline-block rounded border px-1.5 py-[1px] text-[10px] uppercase tracking-wider " +
                  (p.risk_tier === "high"
                    ? "border-[var(--color-danger)]/40 text-[var(--color-danger)] bg-[var(--color-danger)]/10"
                    : p.risk_tier === "medium"
                      ? "border-[var(--color-warn)]/40 text-[var(--color-warn)] bg-[var(--color-warn)]/10"
                      : "border-[var(--color-success)]/40 text-[var(--color-success)] bg-[var(--color-success)]/10")
                }
              >
                {p.risk_tier}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function SharedRunPage({ params }: Props) {
  const { id } = await params;
  const rec: RunRecord | null = await getRun(id);
  if (!rec) notFound();

  const base = await fullUrl();
  const shareUrl = `${base}/r/${rec.id}`;
  const isPredict = rec.kind === "predict" || rec.kind === "demo";

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)] font-sans">
      <div className="max-w-3xl mx-auto px-5 py-8 md:py-12">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] pb-4">
          <Link href="/" className="flex items-center gap-2 group">
            <Pulse weight="duotone" size={18} className="text-[var(--color-accent)]" />
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-semibold tracking-tight">adherence.ml</span>
              <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-muted)]">
                shared run
              </span>
            </div>
          </Link>
          <Link
            href="/demo"
            className="text-[12px] font-mono text-[var(--color-muted)] hover:text-[var(--color-fg)] flex items-center gap-1.5"
          >
            Try it yourself <ArrowRight weight="duotone" size={14} />
          </Link>
        </header>

        <main className="py-8 space-y-6">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--color-accent)] mb-2 flex items-center gap-2">
              <span>{rec.kind}</span>
              {rec.tags.map((t) => (
                <span key={t} className="text-[var(--color-muted)] flex items-center gap-1">
                  <Tag weight="duotone" size={10} /> {t}
                </span>
              ))}
            </div>
            <h1 className="text-[22px] md:text-[26px] font-semibold tracking-tight">{rec.title}</h1>
            {rec.summary ? (
              <p className="text-[14px] text-[var(--color-muted)] mt-2 leading-relaxed">
                {rec.summary}
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 border border-[var(--color-border)] rounded-md p-4 bg-[var(--color-surface)]/40">
            <div className="space-y-0.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)] flex items-center gap-1">
                <Calendar weight="duotone" size={11} /> When
              </div>
              <div className="text-[12px] font-mono">{fmtFull(rec.created_at)}</div>
            </div>
            {rec.user_id ? (
              <div className="space-y-0.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)] flex items-center gap-1">
                  <IdentificationCard weight="duotone" size={11} /> User
                </div>
                <div className="text-[12px] font-mono truncate">{rec.user_id}</div>
              </div>
            ) : null}
            {rec.latency_ms != null ? (
              <div className="space-y-0.5">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)] flex items-center gap-1">
                  <Timer weight="duotone" size={11} /> Latency
                </div>
                <div className="text-[12px] font-mono">{rec.latency_ms} ms</div>
              </div>
            ) : null}
            <div className="space-y-0.5">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)] flex items-center gap-1">
                <ClockCounterClockwise weight="duotone" size={11} /> ID
              </div>
              <div className="text-[12px] font-mono">{rec.id}</div>
            </div>
          </div>

          {isPredict ? <PredictResult payload={rec.payload as PredictPayload} /> : null}

          <details className="border border-[var(--color-border)] rounded-md">
            <summary className="cursor-pointer px-4 py-2 text-[12px] font-mono uppercase tracking-wider text-[var(--color-muted)] hover:text-[var(--color-fg)]">
              Raw payload (JSON)
            </summary>
            <pre className="overflow-x-auto px-4 pb-4 text-[11px] font-mono text-[var(--color-muted)] leading-relaxed">
{JSON.stringify(rec.payload, null, 2)}
            </pre>
          </details>

          <div className="border-t border-[var(--color-border)] pt-4 flex items-center justify-between flex-wrap gap-3">
            <div className="text-[11px] font-mono text-[var(--color-subtle)] truncate">
              {shareUrl}
            </div>
            <Link
              href="/history"
              className="text-[12px] font-mono text-[var(--color-muted)] hover:text-[var(--color-fg)] flex items-center gap-1.5"
            >
              All runs <ArrowRight weight="duotone" size={14} />
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
