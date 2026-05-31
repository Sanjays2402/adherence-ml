/**
 * Runs store: append-only JSONL file under .data/runs.jsonl
 *
 * Pure-stdlib (no native bindings) so it builds cleanly on Node 24/25.
 * Suitable for single-process Next.js dev/preview. For multi-process or
 * horizontal scale, swap the read/write functions for Postgres or Turso.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type RunKind = "predict" | "demo" | "explain" | "cohort" | "forecast" | "other";

export interface RunRecord {
  id: string;
  created_at: number; // epoch ms
  kind: RunKind;
  title: string;
  summary: string;
  user_id: string | null;
  latency_ms: number | null;
  payload: unknown; // raw request+response blob
  tags: string[];
  // Public sharing: when share_token is non-null the run is reachable
  // unauthenticated at /share/<token>. Toggle via setRunShared().
  share_token?: string | null;
  shared_at?: number | null;
  // Pinned runs sort first in listings and can be filtered with `pinned`.
  pinned?: boolean;
  pinned_at?: number | null;
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const RUNS_FILE = path.join(DATA_DIR, "runs.jsonl");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function newRunId(): string {
  // 10-char url-safe id: enough entropy for ~1B records before collision risk
  return randomBytes(8).toString("base64url").slice(0, 12);
}

let writeQueue: Promise<void> = Promise.resolve();

export async function appendRun(rec: RunRecord): Promise<void> {
  ensureDir();
  const line = JSON.stringify(rec) + "\n";
  writeQueue = writeQueue.then(() => fs.appendFile(RUNS_FILE, line, "utf8"));
  return writeQueue;
}

async function readAll(): Promise<RunRecord[]> {
  ensureDir();
  if (!existsSync(RUNS_FILE)) return [];
  const text = await fs.readFile(RUNS_FILE, "utf8");
  const out: RunRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as RunRecord);
    } catch {
      // skip corrupt line; do not crash the store
    }
  }
  return out;
}

export interface ListQuery {
  q?: string;
  kind?: RunKind | "all";
  limit?: number;
  offset?: number;
  from?: number | null;
  to?: number | null;
  /** Match runs that carry ALL of these tags (case-insensitive). */
  tags?: string[];
  /** When true, only return pinned runs. */
  pinned?: boolean;
}

export interface ListResult {
  items: RunRecord[];
  total: number;
  limit: number;
  offset: number;
}

export async function listRuns(query: ListQuery = {}): Promise<ListResult> {
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const all = await readAll();
  const q = query.q?.trim().toLowerCase();
  const kind = query.kind && query.kind !== "all" ? query.kind : null;
  const from = query.from ?? null;
  const to = query.to ?? null;
  const tags = (query.tags ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const pinnedOnly = query.pinned === true;

  const filtered = all.filter((r) => {
    if (pinnedOnly && !r.pinned) return false;
    if (kind && r.kind !== kind) return false;
    if (from !== null && r.created_at < from) return false;
    if (to !== null && r.created_at > to) return false;
    if (tags.length) {
      const have = new Set(r.tags.map((t) => t.toLowerCase()));
      for (const t of tags) {
        if (!have.has(t)) return false;
      }
    }
    if (q) {
      const hay =
        `${r.title} ${r.summary} ${r.user_id ?? ""} ${r.tags.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // pinned first, then newest first
  filtered.sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.created_at - a.created_at;
  });

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  };
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const all = await readAll();
  return all.find((r) => r.id === id) ?? null;
}

export async function deleteRun(id: string): Promise<boolean> {
  ensureDir();
  const all = await readAll();
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return false;
  const tmp = RUNS_FILE + ".tmp";
  const body = next.map((r) => JSON.stringify(r)).join("\n") + (next.length ? "\n" : "");
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, RUNS_FILE);
  return true;
}

/**
 * Bulk delete a list of runs. Returns the number actually removed.
 * Unknown ids are silently ignored. Writes the file once at the end so
 * a 100-id bulk delete is a single rename, not 100.
 */
export async function deleteRuns(ids: string[]): Promise<number> {
  ensureDir();
  const set = new Set(ids);
  if (set.size === 0) return 0;
  const all = await readAll();
  const next = all.filter((r) => !set.has(r.id));
  const removed = all.length - next.length;
  if (removed === 0) return 0;
  const tmp = RUNS_FILE + ".tmp";
  const body = next.map((r) => JSON.stringify(r)).join("\n") + (next.length ? "\n" : "");
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, RUNS_FILE);
  return removed;
}

/**
 * Bulk set the pinned flag on a list of runs. Returns the number of
 * runs whose pinned state actually changed.
 */
export async function setRunsPinned(
  ids: string[],
  pinned: boolean,
): Promise<number> {
  ensureDir();
  const set = new Set(ids);
  if (set.size === 0) return 0;
  const all = await readAll();
  let changed = 0;
  const now = Date.now();
  const next = all.map((r) => {
    if (!set.has(r.id)) return r;
    if (!!r.pinned === pinned) return r;
    changed += 1;
    return { ...r, pinned, pinned_at: pinned ? now : null };
  });
  if (changed === 0) return 0;
  const tmp = RUNS_FILE + ".tmp";
  const body = next.map((r) => JSON.stringify(r)).join("\n") + (next.length ? "\n" : "");
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, RUNS_FILE);
  return changed;
}

export async function countRuns(): Promise<number> {
  const all = await readAll();
  return all.length;
}

export interface RunUpdate {
  title?: string;
  tags?: string[];
  share_token?: string | null;
  shared_at?: number | null;
  pinned?: boolean;
  pinned_at?: number | null;
}

/**
 * Toggle the pinned flag on a run. Pinned runs sort first in listings and
 * can be filtered with `?pinned=1` on the list endpoint. Returns the updated
 * record, or null if no such id.
 */
export async function setRunPinned(
  id: string,
  pinned: boolean,
): Promise<RunRecord | null> {
  const current = await getRun(id);
  if (!current) return null;
  if (!!current.pinned === pinned) return current;
  return updateRun(id, {
    pinned,
    pinned_at: pinned ? Date.now() : null,
  });
}

/** Count pinned runs (optionally filtered by kind). */
export async function countPinned(kind?: RunKind | "all"): Promise<number> {
  const all = await readAll();
  const wanted = kind && kind !== "all" ? kind : null;
  let n = 0;
  for (const r of all) {
    if (!r.pinned) continue;
    if (wanted && r.kind !== wanted) continue;
    n += 1;
  }
  return n;
}

function newShareToken(): string {
  // 22-char url-safe token, ~128 bits entropy
  return randomBytes(16).toString("base64url").slice(0, 22);
}

/**
 * Toggle public sharing for a run. Pass enable=true to mint (or reuse) a
 * token, false to revoke. Returns the updated record, or null if no such id.
 */
export async function setRunShared(
  id: string,
  enable: boolean,
): Promise<RunRecord | null> {
  const current = await getRun(id);
  if (!current) return null;
  if (enable) {
    if (current.share_token) return current;
    return updateRun(id, {
      share_token: newShareToken(),
      shared_at: Date.now(),
    });
  }
  return updateRun(id, { share_token: null, shared_at: null });
}

export async function getRunByShareToken(
  token: string,
): Promise<RunRecord | null> {
  if (!token || token.length < 8) return null;
  const all = await readAll();
  return all.find((r) => r.share_token === token) ?? null;
}

export async function updateRun(
  id: string,
  patch: RunUpdate,
): Promise<RunRecord | null> {
  ensureDir();
  const all = await readAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const next = { ...all[idx], ...patch } as RunRecord;
  all[idx] = next;
  const tmp = RUNS_FILE + ".tmp";
  const body = all.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, RUNS_FILE);
  return next;
}

export async function listAllRuns(): Promise<RunRecord[]> {
  return readAll();
}

/**
 * Return all tags present across runs with their occurrence counts,
 * optionally filtered by kind. Sorted by count desc, then alphabetically.
 */
export async function tagCounts(
  kind?: RunKind | "all",
): Promise<Array<{ tag: string; count: number }>> {
  const all = await readAll();
  const wanted = kind && kind !== "all" ? kind : null;
  const counts = new Map<string, number>();
  for (const r of all) {
    if (wanted && r.kind !== wanted) continue;
    for (const raw of r.tags) {
      const t = raw.trim();
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
}

