// File-backed share store. Persists prediction snapshots so they can be
// rendered at a public `/r/<id>` URL. Intentionally dependency-free.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type { PredictResponse } from "./types";

export interface ShareRow {
  dose_id: string;
  scheduled_at: string;
  dose_class: string;
  dose_strength_mg: number;
}

export interface ShareRecord {
  id: string;
  created_at: number;
  user_id: string;
  top_k: number;
  rows: ShareRow[];
  result: PredictResponse;
  latency_ms: number | null;
  title?: string;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "shares.json");
const MAX_SHARES = 5000;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

interface Store {
  version: 1;
  shares: ShareRecord[];
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.shares)) {
      return parsed;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") {
      // Corrupt file: start fresh rather than 500 the whole route.
      // eslint-disable-next-line no-console
      console.warn("[shares] resetting corrupt store:", code);
    }
  }
  return { version: 1, shares: [] };
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const trimmed: Store = {
    version: 1,
    shares: store.shares.slice(0, MAX_SHARES),
  };
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(trimmed), "utf8");
  await fs.rename(tmp, STORE_PATH);
}

export function newShareId(len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}

export async function createShare(
  input: Omit<ShareRecord, "id" | "created_at">,
): Promise<ShareRecord> {
  const store = await readStore();
  // Avoid the (vanishingly rare) collision.
  let id = newShareId();
  while (store.shares.some((s) => s.id === id)) id = newShareId();
  const record: ShareRecord = {
    id,
    created_at: Date.now(),
    ...input,
  };
  store.shares.unshift(record);
  await writeStore(store);
  return record;
}

export async function getShare(id: string): Promise<ShareRecord | null> {
  if (!/^[a-z0-9]{6,32}$/.test(id)) return null;
  const store = await readStore();
  return store.shares.find((s) => s.id === id) ?? null;
}

export async function countShares(): Promise<number> {
  const store = await readStore();
  return store.shares.length;
}

export interface ShareSummary {
  id: string;
  created_at: number;
  user_id: string;
  title?: string;
  row_count: number;
  prediction_count: number;
  top_risk: number;
  model_version: string;
}

function summarize(s: ShareRecord): ShareSummary {
  const probs = s.result.predictions.map((p) => p.miss_probability);
  const top = probs.length ? Math.max(...probs) : 0;
  return {
    id: s.id,
    created_at: s.created_at,
    user_id: s.user_id,
    title: s.title,
    row_count: s.rows.length,
    prediction_count: s.result.predictions.length,
    top_risk: top,
    model_version: s.result.model_version,
  };
}

export async function listShares(opts: {
  user_id?: string;
  limit?: number;
  offset?: number;
  q?: string;
} = {}): Promise<{ items: ShareSummary[]; total: number; limit: number; offset: number }> {
  const store = await readStore();
  let items = store.shares;
  if (opts.user_id) items = items.filter((s) => s.user_id === opts.user_id);
  if (opts.q && opts.q.trim()) {
    const q = opts.q.trim().toLowerCase();
    items = items.filter(
      (s) =>
        s.id.includes(q) ||
        (s.title ?? "").toLowerCase().includes(q) ||
        s.user_id.toLowerCase().includes(q),
    );
  }
  const total = items.length;
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const page = items.slice(offset, offset + limit).map(summarize);
  return { items: page, total, limit, offset };
}

export async function deleteShare(
  id: string,
  opts: { user_id?: string } = {},
): Promise<{ deleted: boolean; reason?: "not_found" | "forbidden" }> {
  if (!/^[a-z0-9]{6,32}$/.test(id)) return { deleted: false, reason: "not_found" };
  const store = await readStore();
  const idx = store.shares.findIndex((s) => s.id === id);
  if (idx === -1) return { deleted: false, reason: "not_found" };
  if (opts.user_id && store.shares[idx].user_id !== opts.user_id) {
    return { deleted: false, reason: "forbidden" };
  }
  store.shares.splice(idx, 1);
  await writeStore(store);
  return { deleted: true };
}
