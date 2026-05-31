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

  const filtered = all.filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (q) {
      const hay =
        `${r.title} ${r.summary} ${r.user_id ?? ""} ${r.tags.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // newest first
  filtered.sort((a, b) => b.created_at - a.created_at);

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

export async function countRuns(): Promise<number> {
  const all = await readAll();
  return all.length;
}

export interface RunUpdate {
  title?: string;
  tags?: string[];
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

