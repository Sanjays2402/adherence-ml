/**
 * API keys store. File-backed, dependency-free, mirrors the
 * runs-store/shares pattern so it deploys without extra infra.
 *
 * Keys are issued in plaintext exactly once at creation. Only a
 * SHA-256 hash and a short prefix are persisted, so a leaked store
 * file does not leak usable credentials.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

export const ALL_SCOPES = ["predict", "read", "webhooks"] as const;
export type KeyScope = (typeof ALL_SCOPES)[number];
export const DEFAULT_SCOPES: KeyScope[] = ["predict", "read"];

export function normalizeScopes(raw: unknown): KeyScope[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SCOPES];
  const seen = new Set<KeyScope>();
  for (const s of raw) {
    if (typeof s === "string" && (ALL_SCOPES as readonly string[]).includes(s)) {
      seen.add(s as KeyScope);
    }
  }
  // never issue a key with zero scopes; fall back to defaults
  if (seen.size === 0) return [...DEFAULT_SCOPES];
  // preserve canonical order
  return ALL_SCOPES.filter((s) => seen.has(s));
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string; // first 8 chars of plaintext, for UI display
  hash: string; // sha256(plaintext)
  created_at: number;
  last_used_at: number | null;
  use_count: number;
  revoked: boolean;
  rotated_at?: number | null;
  scopes?: KeyScope[];
  /**
   * Absolute expiry timestamp in epoch milliseconds. `null` or omitted means
   * the key never expires. Once `Date.now()` passes this value, `verifyKey`
   * refuses the key with the same semantics as `revoked`.
   */
  expires_at?: number | null;
  /**
   * Optional per-key daily request cap. When set to a positive integer, the
   * key is rate-limited to this many calls per UTC day in addition to the
   * workspace plan quota. `null` or omitted means no per-key cap (the key
   * just inherits the workspace plan quota).
   */
  daily_quota?: number | null;
}

/** Normalize a user-supplied daily quota value into a stored field. */
export function normalizeDailyQuota(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // cap at 10M/day to avoid silly values
  return Math.min(Math.floor(n), 10_000_000);
}

/** True when the key carries a non-null `expires_at` that has already passed. */
export function isExpired(
  rec: Pick<ApiKeyRecord, "expires_at">,
  now: number = Date.now(),
): boolean {
  return typeof rec.expires_at === "number" && rec.expires_at > 0 && rec.expires_at <= now;
}

/**
 * Convert a TTL in days into an absolute `expires_at` epoch-ms value.
 * `null`, `0`, negatives, or non-finite inputs map to `null` (never expires).
 * Capped at 10 years to avoid accidental Number.MAX_VALUE rows.
 */
export function ttlToExpiresAt(
  days: number | null | undefined,
  now: number = Date.now(),
): number | null {
  if (days === null || days === undefined) return null;
  if (!Number.isFinite(days) || days <= 0) return null;
  const capped = Math.min(Math.floor(days), 3650);
  return now + capped * 24 * 60 * 60 * 1000;
}

/** Effective scopes for a record, with safe defaults for legacy rows. */
export function scopesOf(rec: Pick<ApiKeyRecord, "scopes">): KeyScope[] {
  return rec.scopes && rec.scopes.length > 0 ? rec.scopes : [...DEFAULT_SCOPES];
}

/** Public-safe view of a key for UI/API responses (never includes the hash). */
export function publicView(k: ApiKeyRecord) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    created_at: k.created_at,
    last_used_at: k.last_used_at,
    use_count: k.use_count,
    revoked: k.revoked,
    rotated_at: k.rotated_at ?? null,
    scopes: scopesOf(k),
    expires_at: k.expires_at ?? null,
    expired: isExpired(k),
    daily_quota: k.daily_quota ?? null,
  };
}

/**
 * Update mutable fields on an existing key (name, scopes, daily_quota).
 * Returns the updated record, or null if not found / revoked.
 * Only fields explicitly provided in `patch` are touched.
 */
export async function updateKey(
  id: string,
  patch: { name?: string; scopes?: KeyScope[]; daily_quota?: number | null },
): Promise<ApiKeyRecord | null> {
  let out: ApiKeyRecord | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const k = s.keys.find((k) => k.id === id);
    if (!k || k.revoked) return;
    if (typeof patch.name === "string") {
      const trimmed = patch.name.trim().slice(0, 80);
      if (trimmed) k.name = trimmed;
    }
    if (Array.isArray(patch.scopes)) {
      k.scopes = normalizeScopes(patch.scopes);
    }
    if (patch.daily_quota !== undefined) {
      k.daily_quota = normalizeDailyQuota(patch.daily_quota);
    }
    out = { ...k };
    await writeStore(s);
  });
  await writeQueue;
  return out;
}

export function hasScope(rec: Pick<ApiKeyRecord, "scopes">, scope: KeyScope): boolean {
  return scopesOf(rec).includes(scope);
}

export interface NewApiKey {
  record: ApiKeyRecord;
  plaintext: string; // returned exactly once
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "api-keys.json");

interface Store {
  version: 1;
  keys: ApiKeyRecord[];
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return { version: 1, keys: [] };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.keys)) {
      return { version: 1, keys: [] };
    }
    return parsed;
  } catch {
    return { version: 1, keys: [] };
  }
}

async function writeStore(store: Store): Promise<void> {
  ensureDir();
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, STORE_PATH);
}

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function newId(): string {
  return randomBytes(8).toString("base64url").slice(0, 12);
}

export async function listKeys(): Promise<ApiKeyRecord[]> {
  const s = await readStore();
  return [...s.keys].sort((a, b) => b.created_at - a.created_at);
}

export async function createKey(
  name: string,
  scopes: KeyScope[] = DEFAULT_SCOPES,
  expiresAt: number | null = null,
): Promise<NewApiKey> {
  const trimmed = name.trim().slice(0, 80) || "untitled";
  const plaintext = "adh_" + randomBytes(24).toString("base64url");
  const record: ApiKeyRecord = {
    id: newId(),
    name: trimmed,
    prefix: plaintext.slice(0, 12),
    hash: hashKey(plaintext),
    created_at: Date.now(),
    last_used_at: null,
    use_count: 0,
    revoked: false,
    scopes: normalizeScopes(scopes),
    expires_at: expiresAt ?? null,
    daily_quota: null,
  };
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    s.keys.push(record);
    await writeStore(s);
  });
  await writeQueue;
  return { record, plaintext };
}

/**
 * Rotate a key: generate a new plaintext + hash + prefix in place while
 * preserving id, name, created_at, last_used_at, and use_count so dashboards
 * and audit logs stay continuous. Revoked keys cannot be rotated; callers
 * should issue a fresh key instead. Returns the new plaintext exactly once.
 */
export async function rotateKey(id: string): Promise<NewApiKey | null> {
  let issued: NewApiKey | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const k = s.keys.find((k) => k.id === id);
    if (!k || k.revoked || isExpired(k)) return;
    const plaintext = "adh_" + randomBytes(24).toString("base64url");
    k.prefix = plaintext.slice(0, 12);
    k.hash = hashKey(plaintext);
    k.rotated_at = Date.now();
    issued = { record: { ...k }, plaintext };
    await writeStore(s);
  });
  await writeQueue;
  return issued;
}

export async function revokeKey(id: string): Promise<boolean> {
  let ok = false;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const k = s.keys.find((k) => k.id === id);
    if (!k) return;
    k.revoked = true;
    ok = true;
    await writeStore(s);
  });
  await writeQueue;
  return ok;
}

/**
 * Validate a presented key. Returns the matching record on success.
 * Records usage (last_used_at, use_count) as a side effect.
 */
export async function verifyKey(plaintext: string): Promise<ApiKeyRecord | null> {
  if (!plaintext || typeof plaintext !== "string") return null;
  const h = hashKey(plaintext);
  let match: ApiKeyRecord | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const k = s.keys.find((k) => k.hash === h && !k.revoked);
    if (!k) return;
    if (isExpired(k)) return; // expired keys are inert, same as revoked
    k.last_used_at = Date.now();
    k.use_count += 1;
    match = { ...k };
    await writeStore(s);
  });
  await writeQueue;
  return match;
}

export function extractKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
  }
  const x = headers.get("x-api-key");
  if (x) return x.trim();
  return null;
}
