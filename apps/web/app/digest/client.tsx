"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  EnvelopeSimple,
  ArrowsClockwise,
  CheckCircle,
  Warning,
  CalendarBlank,
  PaperPlaneTilt,
  Tag,
} from "@phosphor-icons/react";
import {
  PageHeader,
  Card,
  CardHeader,
  Stat,
  Empty,
  ErrorBox,
  Skeleton,
  Badge,
} from "@/components/ui/primitives";

interface KindRow {
  kind: string;
  count: number;
}
interface DayBucket {
  date: string;
  count: number;
}
interface RecentTitle {
  id: string;
  title: string;
  kind: string;
  at: number;
}
interface Payload {
  window_start: number;
  window_end: number;
  runs_total: number;
  runs_prev_week: number;
  delta_pct: number;
  by_kind: KindRow[];
  by_day: DayBucket[];
  top_tags: Array<{ tag: string; count: number }>;
  recent_titles: RecentTitle[];
  generated_at: number;
}
interface SentRow {
  at: number;
  to: string;
  runs_total: number;
  delivery: "preview" | "logged";
}
interface ApiResp {
  payload: Payload;
  recipient: string | null;
  enabled: boolean;
  sent: SentRow[];
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export default function DigestClient() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/digest", { cache: "no-store" });
      if (!r.ok) throw new Error(`load_failed:${r.status}`);
      setData((await r.json()) as ApiResp);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown_error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendNow = useCallback(async () => {
    setSending(true);
    setFlash(null);
    try {
      const r = await fetch("/api/digest", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await r.json().catch(() => ({}))) as { error?: string; detail?: string; sent?: SentRow };
      if (!r.ok) {
        setFlash(body.detail || body.error || `send_failed:${r.status}`);
      } else {
        setFlash("Digest queued. Check the sent log below.");
        await load();
      }
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "send_failed");
    } finally {
      setSending(false);
      setTimeout(() => setFlash(null), 4000);
    }
  }, [load]);

  const payload = data?.payload;
  const maxDay = payload ? Math.max(1, ...payload.by_day.map((d) => d.count)) : 1;

  return (
    <div>
      <PageHeader
        eyebrow="notifications"
        title="Weekly digest"
        description="A 7-day summary of runs, top tags, and recent activity, ready to deliver to your contact email every Monday."
        actions={
          <>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--color-border)]/40"
              title="Recompute"
            >
              <ArrowsClockwise weight="duotone" size={14} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void sendNow()}
              disabled={sending || !data?.recipient}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50"
              title={data?.recipient ? `Send to ${data.recipient}` : "Set a contact email in /settings first"}
            >
              <PaperPlaneTilt weight="duotone" size={14} />
              {sending ? "Sending..." : "Send digest now"}
            </button>
          </>
        }
      />

      <div className="px-6 py-5 space-y-5">
        {flash ? (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-fg)]/85">
            {flash}
          </div>
        ) : null}

        {error ? <ErrorBox message={error} /> : null}

        {loading && !payload ? (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : null}

        {payload ? (
          <>
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat
                label="Runs this week"
                value={payload.runs_total.toString()}
                sub={`${fmtDate(payload.window_start)} to ${fmtDate(payload.window_end)}`}
              />
              <Stat
                label="vs prior week"
                value={`${payload.delta_pct >= 0 ? "+" : ""}${payload.delta_pct.toFixed(1)}%`}
                sub={`prev: ${payload.runs_prev_week}`}
              />
              <Stat
                label="Recipient"
                value={data?.recipient ? <span className="text-sm">{data.recipient}</span> : <span className="text-sm text-[var(--color-muted)]">not set</span>}
                sub={
                  data?.enabled ? (
                    <span className="text-[var(--color-success)]">enabled</span>
                  ) : (
                    <span className="text-[var(--color-warn)]">disabled in settings</span>
                  )
                }
              />
              <Stat
                label="Next scheduled"
                value={<span className="text-sm">{nextMonday()}</span>}
                sub="Monday 09:00 UTC"
              />
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="lg:col-span-2">
                <CardHeader title="7-day activity" hint="One bar per day, UTC" />
                <div className="p-4">
                  <div className="flex items-end gap-2 h-32">
                    {payload.by_day.map((d) => {
                      const h = Math.round((d.count / maxDay) * 100);
                      return (
                        <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                          <div className="text-[10px] font-mono text-[var(--color-muted)] tabular-nums">{d.count}</div>
                          <div
                            className="w-full bg-[var(--color-accent)]/60 rounded-sm"
                            style={{ height: `${Math.max(4, h)}%` }}
                            aria-label={`${d.date}: ${d.count} runs`}
                          />
                          <div className="text-[10px] font-mono text-[var(--color-muted)] truncate w-full text-center">{d.date.slice(5)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader title="By kind" hint="Across the 7-day window" />
                <div className="p-4">
                  {payload.by_kind.length === 0 ? (
                    <Empty title="No activity yet" hint="Run a prediction or open the demo to seed the digest." icon={<CalendarBlank weight="duotone" size={28} />} />
                  ) : (
                    <ul className="space-y-2">
                      {payload.by_kind.map((r) => (
                        <li key={r.kind} className="flex items-center justify-between text-sm">
                          <span className="font-mono text-xs">{r.kind}</span>
                          <span className="tabular-nums">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </section>

            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader title="Top tags" />
                <div className="p-4 flex flex-wrap gap-2">
                  {payload.top_tags.length === 0 ? (
                    <span className="text-xs text-[var(--color-muted)]">No tags in this window.</span>
                  ) : (
                    payload.top_tags.map((t) => (
                      <Badge key={t.tag} tone="accent">
                        <Tag weight="duotone" size={10} />
                        {t.tag} · {t.count}
                      </Badge>
                    ))
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader title="Recent runs" />
                <div className="p-2">
                  {payload.recent_titles.length === 0 ? (
                    <Empty title="Nothing recent" />
                  ) : (
                    <ul>
                      {payload.recent_titles.map((r) => (
                        <li key={r.id}>
                          <Link
                            href={`/history/${r.id}`}
                            className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-[var(--color-border)]/40"
                          >
                            <span className="truncate">{r.title}</span>
                            <span className="text-[10px] font-mono text-[var(--color-muted)] shrink-0">{r.kind}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </section>

            <section>
              <Card>
                <CardHeader
                  title="Email preview"
                  hint="Exactly what the recipient sees, rendered with inline styles for Gmail/Apple Mail."
                  right={
                    <a
                      href="/api/digest?format=html"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
                    >
                      <EnvelopeSimple weight="duotone" size={14} />
                      open raw
                    </a>
                  }
                />
                <div className="p-3 bg-white">
                  <iframe
                    src="/api/digest?format=html"
                    title="Email digest preview"
                    className="w-full rounded border border-[var(--color-border)] bg-white"
                    style={{ height: 560 }}
                  />
                </div>
              </Card>
            </section>

            <section>
              <Card>
                <CardHeader title="Delivery log" hint="Most recent 10 digest sends recorded on this host." />
                {data?.sent.length === 0 ? (
                  <Empty
                    title="No digests sent yet"
                    hint="Press 'Send digest now' to record a delivery. Wire SMTP/Resend in lib/digest-store.ts to mail it for real."
                    icon={<EnvelopeSimple weight="duotone" size={28} />}
                  />
                ) : (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {data?.sent.map((s, i) => (
                      <li key={`${s.at}-${i}`} className="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          {s.delivery === "logged" ? (
                            <CheckCircle weight="duotone" size={16} className="text-[var(--color-success)] shrink-0" />
                          ) : (
                            <Warning weight="duotone" size={16} className="text-[var(--color-warn)] shrink-0" />
                          )}
                          <span className="truncate font-mono text-xs">{s.to}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] shrink-0">
                          <span className="tabular-nums">{s.runs_total} runs</span>
                          <span>{fmtTime(s.at)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function nextMonday(): string {
  const now = new Date();
  const dow = now.getUTCDay();
  const daysAhead = (8 - dow) % 7 || 7;
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysAhead);
  next.setUTCHours(9, 0, 0, 0);
  return next.toISOString().slice(0, 10);
}
