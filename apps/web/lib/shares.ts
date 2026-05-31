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
