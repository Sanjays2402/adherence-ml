/**
 * Weekly activity digest.
 *
 * Aggregates the past 7 days of runs, usage events, and webhook deliveries
 * into a single payload that powers the in-app preview at /digest and the
 * (future) outbound email job. The "sent log" is persisted to disk so the
 * /digest page can show when the last digest was generated and the next
 * scheduled window.
 *
 * Same file-backed pattern as the other stores in this directory: no
 * native deps, safe on Node 24/25, swappable for Postgres later.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { listAllRuns, type RunRecord } from "./runs-store";

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const SENT_LOG = path.join(DATA_DIR, "digest-sent.json");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export interface DigestKindRow {
  kind: RunRecord["kind"];
  count: number;
}

export interface DigestDayBucket {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

export interface DigestPayload {
  window_start: number;
  window_end: number;
  runs_total: number;
  runs_prev_week: number;
  delta_pct: number; // (cur - prev) / max(1, prev) * 100
  by_kind: DigestKindRow[];
  by_day: DigestDayBucket[]; // 7 entries, oldest first
  top_tags: Array<{ tag: string; count: number }>;
  recent_titles: Array<{ id: string; title: string; kind: string; at: number }>;
  generated_at: number;
}

export interface DigestSendRecord {
  at: number;
  to: string;
  runs_total: number;
  window_end: number;
  // delivery is "preview" until a real SMTP/Resend transport is wired
  delivery: "preview" | "logged";
}

interface SentLog {
  version: 1;
  entries: DigestSendRecord[];
}

async function readSentLog(): Promise<SentLog> {
  ensureDir();
  if (!existsSync(SENT_LOG)) return { version: 1, entries: [] };
  try {
    const raw = await fs.readFile(SENT_LOG, "utf8");
    const parsed = JSON.parse(raw) as Partial<SentLog>;
    return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

let writeQueue: Promise<void> = Promise.resolve();

async function appendSent(rec: DigestSendRecord): Promise<void> {
  const next = await readSentLog();
  next.entries.unshift(rec);
  if (next.entries.length > 50) next.entries.length = 50;
  writeQueue = writeQueue.then(() =>
    fs.writeFile(SENT_LOG, JSON.stringify(next, null, 2), "utf8"),
  );
  return writeQueue;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildDigest(
  runs: RunRecord[],
  now: number = Date.now(),
): DigestPayload {
  const window_end = now;
  const window_start = now - WEEK_MS;
  const prev_start = now - 2 * WEEK_MS;

  const cur = runs.filter((r) => r.created_at >= window_start && r.created_at <= window_end);
  const prev = runs.filter((r) => r.created_at >= prev_start && r.created_at < window_start);

  const kindCounts = new Map<RunRecord["kind"], number>();
  for (const r of cur) kindCounts.set(r.kind, (kindCounts.get(r.kind) ?? 0) + 1);
  const by_kind: DigestKindRow[] = [...kindCounts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);

  // 7-day buckets, oldest first
  const by_day: DigestDayBucket[] = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = now - i * DAY_MS;
    const iso = utcDate(dayStart);
    const count = cur.filter((r) => utcDate(r.created_at) === iso).length;
    by_day.push({ date: iso, count });
  }

  const tagCounts = new Map<string, number>();
  for (const r of cur) {
    for (const t of r.tags) {
      const k = t.trim().toLowerCase();
      if (!k) continue;
      tagCounts.set(k, (tagCounts.get(k) ?? 0) + 1);
    }
  }
  const top_tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const recent_titles = [...cur]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 5)
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind, at: r.created_at }));

  const delta_pct =
    prev.length === 0
      ? cur.length > 0
        ? 100
        : 0
      : ((cur.length - prev.length) / prev.length) * 100;

  return {
    window_start,
    window_end,
    runs_total: cur.length,
    runs_prev_week: prev.length,
    delta_pct: Math.round(delta_pct * 10) / 10,
    by_kind,
    by_day,
    top_tags,
    recent_titles,
    generated_at: now,
  };
}

export async function currentDigest(now: number = Date.now()): Promise<DigestPayload> {
  const runs = await listAllRuns();
  return buildDigest(runs, now);
}

export async function listSent(limit = 10): Promise<DigestSendRecord[]> {
  const log = await readSentLog();
  return log.entries.slice(0, Math.max(1, limit));
}

export async function logSend(
  to: string,
  payload: DigestPayload,
  delivery: DigestSendRecord["delivery"] = "logged",
): Promise<DigestSendRecord> {
  const rec: DigestSendRecord = {
    at: Date.now(),
    to,
    runs_total: payload.runs_total,
    window_end: payload.window_end,
    delivery,
  };
  await appendSent(rec);
  return rec;
}

/**
 * Render the digest as a self-contained HTML email body. Inline styles only,
 * dark-on-light, safe for Gmail/Apple Mail. No external assets.
 */
export function renderDigestHtml(payload: DigestPayload, opts: { recipient?: string; appUrl?: string } = {}): string {
  const appUrl = (opts.appUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const dateRange =
    new Date(payload.window_start).toISOString().slice(0, 10) +
    " to " +
    new Date(payload.window_end).toISOString().slice(0, 10);
  const arrow = payload.delta_pct >= 0 ? "▲" : "▼";
  const deltaColor = payload.delta_pct >= 0 ? "#16a34a" : "#dc2626";
  const kindRows =
    payload.by_kind.length === 0
      ? `<tr><td style="padding:8px 0;color:#6b7280;">No activity in this window.</td></tr>`
      : payload.by_kind
          .map(
            (r) =>
              `<tr><td style="padding:6px 0;color:#111827;font-family:ui-monospace,monospace;">${r.kind}</td><td style="padding:6px 0;text-align:right;color:#111827;">${r.count}</td></tr>`,
          )
          .join("");
  const tagPills =
    payload.top_tags.length === 0
      ? `<span style="color:#6b7280;">none</span>`
      : payload.top_tags
          .map(
            (t) =>
              `<span style="display:inline-block;border:1px solid #e5e7eb;border-radius:9999px;padding:2px 8px;margin:2px 4px 2px 0;font-size:12px;color:#374151;">${t.tag} · ${t.count}</span>`,
          )
          .join("");
  const recentItems =
    payload.recent_titles.length === 0
      ? `<li style="color:#6b7280;">No recent runs.</li>`
      : payload.recent_titles
          .map(
            (r) =>
              `<li style="margin:6px 0;color:#111827;"><a href="${appUrl}/history/${r.id}" style="color:#2563eb;text-decoration:none;">${escapeHtml(r.title)}</a> <span style="color:#6b7280;font-size:12px;">· ${r.kind}</span></li>`,
          )
          .join("");
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:ui-sans-serif,-apple-system,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:24px 28px 8px 28px;">
          <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">adherence.ml · weekly digest</div>
          <div style="font-size:20px;font-weight:600;margin-top:4px;">${payload.runs_total} runs this week</div>
          <div style="font-size:13px;color:#6b7280;margin-top:2px;">${dateRange} · <span style="color:${deltaColor};">${arrow} ${Math.abs(payload.delta_pct).toFixed(1)}% vs prior week</span></div>
        </td></tr>
        <tr><td style="padding:8px 28px 0 28px;">
          <div style="font-size:13px;font-weight:600;color:#111827;margin-top:16px;">By kind</div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #f1f5f9;margin-top:6px;font-size:14px;">${kindRows}</table>
        </td></tr>
        <tr><td style="padding:0 28px;">
          <div style="font-size:13px;font-weight:600;color:#111827;margin-top:20px;">Top tags</div>
          <div style="margin-top:6px;">${tagPills}</div>
        </td></tr>
        <tr><td style="padding:0 28px 8px 28px;">
          <div style="font-size:13px;font-weight:600;color:#111827;margin-top:20px;">Recent runs</div>
          <ul style="margin:6px 0 0 0;padding:0 0 0 18px;font-size:14px;">${recentItems}</ul>
        </td></tr>
        <tr><td style="padding:20px 28px 24px 28px;">
          <a href="${appUrl}/history" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:13px;padding:10px 14px;border-radius:8px;">Open history</a>
          <a href="${appUrl}/settings" style="display:inline-block;margin-left:8px;color:#374151;font-size:12px;text-decoration:none;">Unsubscribe in settings</a>
        </td></tr>
      </table>
      ${opts.recipient ? `<div style="font-size:11px;color:#9ca3af;margin-top:10px;">Sent to ${escapeHtml(opts.recipient)}</div>` : ""}
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Test-only helper.
export async function _resetSent(): Promise<void> {
  ensureDir();
  if (existsSync(SENT_LOG)) await fs.rm(SENT_LOG);
}
