/**
 * Usage events store. Append-only daily counter file. Same file-backed
 * pattern as runs-store / api-keys-store so it deploys without infra.
 *
 * One event per /v1/predict call. We bucket by UTC date and key_id so
 * the /usage page can render a 30-day sparkline plus per-key breakdown
 * without scanning a giant log.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface UsageEvent {
  ts: number;
  date: string; // YYYY-MM-DD (UTC)
  key_id: string;
  key_prefix: string;
  status: number;
  latency_ms: number;
}

export interface DayBucket {
  date: string;
  total: number;
  by_key: Record<string, number>;
}

interface Store {
  version: 1;
  days: DayBucket[]; // sorted ascending by date
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "usage.json");

// Free-tier quota: requests/day. Override with ADHERENCE_FREE_DAILY_QUOTA.
export const FREE_DAILY_QUOTA = Number(
  process.env.ADHERENCE_FREE_DAILY_QUOTA ?? 500,
);

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return { version: 1, days: [] };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.days)) {
      return { version: 1, days: [] };
    }
    return parsed;
  } catch {
    return { version: 1, days: [] };
  }
}

async function writeStore(store: Store): Promise<void> {
  ensureDir();
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, STORE_PATH);
}

export function todayUtc(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export async function recordUsage(ev: Omit<UsageEvent, "date">): Promise<void> {
  const date = todayUtc(new Date(ev.ts));
  const run = async () => {
    const s = await readStore();
    let bucket = s.days.find((b) => b.date === date);
    if (!bucket) {
      bucket = { date, total: 0, by_key: {} };
      s.days.push(bucket);
      s.days.sort((a, b) => a.date.localeCompare(b.date));
    }
    bucket.total += 1;
    bucket.by_key[ev.key_id] = (bucket.by_key[ev.key_id] ?? 0) + 1;
    // Keep last 90 days to bound file size
    if (s.days.length > 90) s.days = s.days.slice(-90);
    await writeStore(s);
  };
  writeQueue = writeQueue.then(run, run);
  return writeQueue;
}

export async function usedToday(): Promise<number> {
  const s = await readStore();
  const date = todayUtc();
  return s.days.find((b) => b.date === date)?.total ?? 0;
}

export interface UsageSummary {
  quota: number;
  used_today: number;
  remaining_today: number;
  pct_today: number;
  used_30d: number;
  days: DayBucket[]; // last 30, ascending
  by_key_30d: Array<{ key_id: string; count: number }>;
}

export async function summary(): Promise<UsageSummary> {
  const s = await readStore();
  const today = todayUtc();
  const window = s.days.slice(-30);
  // Backfill empty days for a clean sparkline
  const filled: DayBucket[] = [];
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 29);
  for (let i = 0; i < 30; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const found = window.find((b) => b.date === iso);
    filled.push(found ?? { date: iso, total: 0, by_key: {} });
  }
  const used_today = filled.find((b) => b.date === today)?.total ?? 0;
  const used_30d = filled.reduce((a, b) => a + b.total, 0);
  const byKey: Record<string, number> = {};
  for (const b of filled) {
    for (const [k, v] of Object.entries(b.by_key)) {
      byKey[k] = (byKey[k] ?? 0) + v;
    }
  }
  const by_key_30d = Object.entries(byKey)
    .map(([key_id, count]) => ({ key_id, count }))
    .sort((a, b) => b.count - a.count);
  return {
    quota: FREE_DAILY_QUOTA,
    used_today,
    remaining_today: Math.max(0, FREE_DAILY_QUOTA - used_today),
    pct_today: Math.min(1, used_today / Math.max(1, FREE_DAILY_QUOTA)),
    used_30d,
    days: filled,
    by_key_30d,
  };
}

// Test-only helper.
export async function _reset(): Promise<void> {
  if (existsSync(STORE_PATH)) await fs.rm(STORE_PATH);
}
