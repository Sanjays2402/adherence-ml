"use client";

import { useEffect, useState } from "react";
import {
  Lightning,
  Plus,
  Trash,
  Spinner,
  CheckCircle,
  Timer,
  ClockCounterClockwise,
  ArrowCounterClockwise,
  ShareNetwork,
  Copy,
  Check,
  X,
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
import { RiskBarChart } from "@/components/charts/risk-bars";

interface Row {
  dose_id: string;
  scheduled_at: string;
  dose_class: DoseClass;
  dose_strength_mg: number;
}

interface HistoryEntry {
  id: string;
  ts: number;
  user_id: string;
  top_k: number;
  rows: Row[];
  result: PredictResponse;
  latency_ms: number;
}

const HISTORY_KEY = "adherence:predict:history:v1";
const HISTORY_MAX = 8;

function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX)));
  } catch {
    // quota or disabled storage; ignore
  }
}

function avgMiss(p: PredictResponse): number {
  if (p.predictions.length === 0) return 0;
  return p.predictions.reduce((s, x) => s + x.miss_probability, 0) / p.predictions.length;
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const CLASSES: DoseClass[] = [
  "cardio", "neuro", "endocrine", "psych", "antibiotic", "supplement", "other",
];

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
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  async function share() {
    if (!result) return;
    setSharing(true);
    setShareError(null);
    setShareUrl(null);
    setCopied(false);
    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: userId.trim(),
          top_k: topK,
          rows: rows.map((r) => ({
            dose_id: r.dose_id,
            scheduled_at: r.scheduled_at,
            dose_class: r.dose_class,
            dose_strength_mg: Number(r.dose_strength_mg) || 0,
          })),
          result,
          latency_ms: latencyMs,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.detail === "string" ? data.detail : `share failed (${res.status})`);
      }
      const abs = typeof window !== "undefined" ? `${window.location.origin}${data.url}` : data.url;
      setShareUrl(abs);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : String(err));
    } finally {
      setSharing(false);
    }
  }

  async function copyShareUrl() {
    if (!shareUrl || typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore
    }
  }

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

  function restoreEntry(e: HistoryEntry) {
    setUserId(e.user_id);
    setTopK(e.top_k);
    setRows(e.rows.map((r) => ({ ...r })));
    setResult(e.result);
    setLatencyMs(e.latency_ms);
    setError(null);
  }

  function clearHistory() {
    setHistory([]);
    saveHistory([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    setLatencyMs(null);
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
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
      const elapsed = Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
      );
      if (!res.ok) {
        throw new Error(typeof data?.detail === "string" ? data.detail : `request failed (${res.status})`);
      }
      const typed = data as PredictResponse;
      setResult(typed);
      setLatencyMs(elapsed);
      const entry: HistoryEntry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        user_id: userId.trim(),
        top_k: topK,
        rows: rows.map((r) => ({ ...r })),
        result: typed,
        latency_ms: elapsed,
      };
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, HISTORY_MAX);
        saveHistory(next);
        return next;
      });
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
            right={
              result ? (
                <div className="flex items-center gap-2">
                  {latencyMs !== null ? (
                    <Badge tone="neutral">
                      <Timer weight="duotone" size={10} /> {latencyMs} ms
                    </Badge>
                  ) : null}
                  <Badge tone="success">
                    <CheckCircle weight="duotone" size={10} /> ok
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={share}
                    disabled={sharing}
                    aria-label="share result"
                  >
                    {sharing ? (
                      <Spinner weight="duotone" size={12} className="animate-spin" />
                    ) : (
                      <ShareNetwork weight="duotone" size={12} />
                    )}
                    {sharing ? "Sharing" : "Share"}
                  </Button>
                </div>
              ) : null
            }
          />
          {shareUrl || shareError ? (
            <div className="px-4 pt-3 pb-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]/40">
              {shareError ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-[var(--color-danger)]">{shareError}</div>
                  <Button type="button" variant="ghost" onClick={() => setShareError(null)} aria-label="dismiss">
                    <X weight="duotone" size={12} />
                  </Button>
                </div>
              ) : shareUrl ? (
                <div className="space-y-2">
                  <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)]">
                    public shareable url
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={shareUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1.5 text-xs font-mono text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                    />
                    <Button type="button" variant="ghost" onClick={copyShareUrl}>
                      {copied ? (
                        <Check weight="duotone" size={12} />
                      ) : (
                        <Copy weight="duotone" size={12} />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                    <a
                      href={shareUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[var(--color-accent)] hover:underline px-1"
                    >
                      Open
                    </a>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {result && result.predictions.length > 0 ? (
            <div className="px-4 pt-3 pb-1 border-b border-[var(--color-border)]">
              <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[var(--color-muted)] mb-1">
                miss probability by dose
              </div>
              <RiskBarChart predictions={result.predictions} />
            </div>
          ) : null}
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

      {history.length > 0 ? (
        <div className="px-6 pb-6">
          <Card>
            <CardHeader
              title="Recent runs"
              hint={`Last ${history.length} prediction${history.length === 1 ? "" : "s"} on this device. Click a card to restore.`}
              right={
                <Button type="button" variant="ghost" onClick={clearHistory}>
                  <ArrowCounterClockwise weight="duotone" size={12} /> Clear
                </Button>
              }
            />
            <div className="p-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {history.map((h) => {
                const avg = avgMiss(h.result);
                const tier = avg >= 0.7 ? "danger" : avg >= 0.4 ? "warn" : "success";
                const colorVar =
                  tier === "danger"
                    ? "var(--color-danger)"
                    : tier === "warn"
                    ? "var(--color-warn)"
                    : "var(--color-success)";
                return (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => restoreEntry(h)}
                    className={cn(
                      "text-left rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-3 py-2",
                      "hover:border-[var(--color-accent)] hover:bg-[var(--color-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] transition-colors",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-muted)] inline-flex items-center gap-1">
                        <ClockCounterClockwise weight="duotone" size={10} />
                        {relTime(h.ts)}
                      </span>
                      <Badge tone={tier}>{fmtPct(avg)}</Badge>
                    </div>
                    <div className="mt-1 text-xs font-mono truncate text-[var(--color-fg)]/80">
                      {h.user_id}
                    </div>
                    <div className="mt-2 flex items-end gap-[2px] h-7">
                      {h.result.predictions.slice(0, 12).map((p, i) => {
                        const h_pct = Math.max(6, Math.round(p.miss_probability * 100));
                        const pColor =
                          p.risk_tier === "high"
                            ? "var(--color-danger)"
                            : p.risk_tier === "medium"
                            ? "var(--color-warn)"
                            : "var(--color-success)";
                        return (
                          <span
                            key={i}
                            className="flex-1 rounded-sm"
                            style={{
                              height: `${h_pct}%`,
                              background: pColor,
                              opacity: 0.85,
                            }}
                            aria-hidden
                          />
                        );
                      })}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--color-muted)] tabular-nums">
                      <span>{h.result.predictions.length} doses</span>
                      <span>{h.latency_ms} ms</span>
                    </div>
                    <div
                      className="mt-2 h-[2px] w-full rounded-full"
                      style={{ background: colorVar, opacity: 0.5 }}
                      aria-hidden
                    />
                  </button>
                );
              })}
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
