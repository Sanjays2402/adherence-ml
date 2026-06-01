/**
 * Idempotency-Key store.
 *
 * Procurement reality: any enterprise integration team that wires a webhook
 * receiver, a queue consumer, or a flaky network path will retry the same
 * mutating call multiple times. Without server-side idempotency the same
 * invite gets sent five times, the same api key gets minted five times, and
 * the same webhook subscription gets duplicated. Stripe, AWS, and Twilio
 * all solve this with an "Idempotency-Key" request header that the server
 * caches against. We do the same.
 *
 * Scope:
 *   - Per-workspace cache; never crosses tenants.
 *   - Caches the response body, status code, and a content hash of the
 *     request (method + path + json body) for a fixed TTL of 24 hours.
 *   - On replay with the same hash, returns the cached response with
 *     `Idempotent-Replay: true` and the original `Idempotency-Key` echoed.
 *   - On replay with a DIFFERENT hash, returns 409 Conflict so the client
 *     learns it is reusing a key for a different request body (a real bug,
 *     not a retry).
 *
 * Persistence is the same file-backed JSON store the rest of the app uses,
 * so a restart preserves the cache and there is zero external infra.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 200;
export const IDEMPOTENCY_BODY_MAX_BYTES = 64 * 1024; // 64 KiB

export interface IdempotencyRecord {
  workspace_id: string;
  key: string;
  /** sha256 of `${method}\n${path}\n${body_or_empty}` */
  request_hash: string;
  status: number;
  /** Response body as a UTF-8 string. JSON typically; opaque otherwise. */
  body: string;
  /** Stored response content-type so replays match the original. */
  content_type: string;
  created_at: number;
  expires_at: number;
}

interface Store {
  version: 1;
  records: IdempotencyRecord[];
}

const DATA_DIR = () =>
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = () => path.join(DATA_DIR(), "idempotency.json");

function ensureDir() {
  const dir = DATA_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  const p = STORE_PATH();
  if (!existsSync(p)) return { version: 1, records: [] };
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1) return { version: 1, records: [] };
    parsed.records = Array.isArray(parsed.records) ? parsed.records : [];
    return parsed;
  } catch {
    return { version: 1, records: [] };
  }
}

async function writeStore(store: Store): Promise<void> {
  ensureDir();
  const body = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(STORE_PATH(), body, "utf8"));
  return writeQueue;
}

export function isValidIdempotencyKey(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length < IDEMPOTENCY_KEY_MIN || raw.length > IDEMPOTENCY_KEY_MAX)
    return false;
  // Printable ASCII only; reject control chars and whitespace boundaries.
  if (!/^[\x21-\x7E]+$/.test(raw)) return false;
  return true;
}

export function hashRequest(
  method: string,
  pathname: string,
  rawBody: string | null,
): string {
  const h = createHash("sha256");
  h.update(method.toUpperCase());
  h.update("\n");
  h.update(pathname);
  h.update("\n");
  h.update(rawBody ?? "");
  return h.digest("hex");
}

export async function lookupRecord(
  workspaceId: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  const store = await readStore();
  const now = Date.now();
  const rec = store.records.find(
    (r) => r.workspace_id === workspaceId && r.key === key && r.expires_at > now,
  );
  return rec ?? null;
}

export async function storeRecord(
  workspaceId: string,
  key: string,
  requestHash: string,
  status: number,
  body: string,
  contentType: string,
): Promise<IdempotencyRecord> {
  const store = await readStore();
  const now = Date.now();
  // Sweep expired records on every write so the file does not grow forever.
  store.records = store.records.filter((r) => r.expires_at > now);
  // Replace existing record for (workspace, key) if any (shouldn't happen
  // since the caller looked up first, but defensive against races).
  store.records = store.records.filter(
    (r) => !(r.workspace_id === workspaceId && r.key === key),
  );
  const rec: IdempotencyRecord = {
    workspace_id: workspaceId,
    key,
    request_hash: requestHash,
    status,
    body,
    content_type: contentType,
    created_at: now,
    expires_at: now + IDEMPOTENCY_TTL_MS,
  };
  store.records.push(rec);
  await writeStore(store);
  return rec;
}

export async function listRecords(
  workspaceId: string,
): Promise<IdempotencyRecord[]> {
  const store = await readStore();
  const now = Date.now();
  return store.records
    .filter((r) => r.workspace_id === workspaceId && r.expires_at > now)
    .sort((a, b) => b.created_at - a.created_at);
}

export async function deleteRecord(
  workspaceId: string,
  key: string,
): Promise<boolean> {
  const store = await readStore();
  const before = store.records.length;
  store.records = store.records.filter(
    (r) => !(r.workspace_id === workspaceId && r.key === key),
  );
  if (store.records.length === before) return false;
  await writeStore(store);
  return true;
}

export async function clearWorkspace(workspaceId: string): Promise<number> {
  const store = await readStore();
  const before = store.records.length;
  store.records = store.records.filter((r) => r.workspace_id !== workspaceId);
  const removed = before - store.records.length;
  if (removed > 0) await writeStore(store);
  return removed;
}

export async function _resetForTests(): Promise<void> {
  const p = STORE_PATH();
  try {
    await fs.unlink(p);
  } catch {
    /* fine */
  }
  writeQueue = Promise.resolve();
}
