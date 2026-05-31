/**
 * Per-API-key usage events. Append-only JSONL, mirrors runs-store.
 * Lets the API keys detail page show recent calls + a 14-day chart
 * + per-endpoint counts so customers can see what their key is doing.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface KeyUsageEvent {
  key_id: string;
  ts: number; // epoch ms
  method: string;
  path: string; // request pathname, e.g. /v1/predict
  status: number;
  latency_ms: number;
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "api-key-usage.jsonl");

// Hard cap on file size to keep things bounded in dev. When we cross it
// we rewrite the file keeping only the most recent MAX_KEEP events.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_KEEP = 5000;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

export async function recordKeyUsage(ev: KeyUsageEvent): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    ensureDir();
    const line = JSON.stringify(ev) + "\n";
    await fs.appendFile(STORE_PATH, line, "utf8");
    try {
      const st = await fs.stat(STORE_PATH);
      if (st.size > MAX_BYTES) await compact();
    } catch {
      // best-effort compaction
    }
  });
  await writeQueue;
}

async function compact(): Promise<void> {
  const all = await readAll();
  const keep = all.slice(-MAX_KEEP);
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  await fs.rename(tmp, STORE_PATH);
}

async function readAll(): Promise<KeyUsageEvent[]> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return [];
  const raw = await fs.readFile(STORE_PATH, "utf8");
  const out: KeyUsageEvent[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s) as KeyUsageEvent;
      if (v && typeof v.key_id === "string" && typeof v.ts === "number") out.push(v);
    } catch {
      // skip bad lines
    }
  }
  return out;
}

export interface UsageSummary {
  total: number;
  last_24h: number;
  last_7d: number;
  daily: Array<{ day: string; count: number }>; // last 14 days, oldest first
  by_endpoint: Array<{ path: string; count: number }>;
  by_status: Array<{ status: number; count: number }>;
  recent: KeyUsageEvent[]; // newest first
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function summarizeKeyUsage(
  keyId: string,
  opts: { recentLimit?: number } = {},
): Promise<UsageSummary> {
  const all = (await readAll()).filter((e) => e.key_id === keyId);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const last24h = all.filter((e) => now - e.ts < dayMs).length;
  const last7d = all.filter((e) => now - e.ts < 7 * dayMs).length;

  // Build 14-day window (oldest first)
  const buckets = new Map<string, number>();
  for (let i = 13; i >= 0; i--) {
    buckets.set(dayKey(now - i * dayMs), 0);
  }
  for (const e of all) {
    if (now - e.ts < 14 * dayMs) {
      const k = dayKey(e.ts);
      if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
  }
  const daily = Array.from(buckets.entries()).map(([day, count]) => ({ day, count }));

  const epMap = new Map<string, number>();
  const stMap = new Map<number, number>();
  for (const e of all) {
    epMap.set(e.path, (epMap.get(e.path) ?? 0) + 1);
    stMap.set(e.status, (stMap.get(e.status) ?? 0) + 1);
  }
  const by_endpoint = Array.from(epMap.entries())
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);
  const by_status = Array.from(stMap.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const limit = Math.max(1, Math.min(opts.recentLimit ?? 50, 200));
  const recent = [...all].sort((a, b) => b.ts - a.ts).slice(0, limit);
  return { total: all.length, last_24h: last24h, last_7d: last7d, daily, by_endpoint, by_status, recent };
}

// Test helper: clear store.
export async function _resetUsageForTests(): Promise<void> {
  if (existsSync(STORE_PATH)) await fs.unlink(STORE_PATH);
}
