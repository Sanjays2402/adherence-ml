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
  /**
   * Grace-period rotation: when set, the previous secret remains valid until
   * `previous_expires_at`, letting callers roll out the new key without
   * dropping in-flight traffic. Cleared on revoke-previous, expiry, or the
   * next rotation.
   */
  previous_hash?: string | null;
  previous_prefix?: string | null;
  previous_expires_at?: number | null;
  scopes?: KeyScope[];
  /**
   * Absolute expiry timestamp in epoch milliseconds. `null` or omitted means
   * the key never expires. Once `Date.now()` passes this value, `verifyKey`
   * refuses the key with the same semantics as `revoked`.
   */
  expires_at?: number | null;
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

/** True when a previous-secret grace window is set and still in the future. */
export function hasActiveGrace(
  rec: Pick<ApiKeyRecord, "previous_hash" | "previous_expires_at">,
  now: number = Date.now(),
): boolean {
  return (
    !!rec.previous_hash &&
    typeof rec.previous_expires_at === "number" &&
    rec.previous_expires_at > now
  );
}

/** Public-safe view of a key for UI/API responses (never includes the hash). */
export function publicView(k: ApiKeyRecord) {
  const graceActive = hasActiveGrace(k);
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
    previous_prefix: graceActive ? k.previous_prefix ?? null : null,
    previous_expires_at: graceActive ? k.previous_expires_at ?? null : null,
    grace_active: graceActive,
  };
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
  };
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    s.keys.push(record);
    await writeStore(s);
  });
  await writeQueue;
  return { record, plaintext };
}

/** Cap grace windows to 30 days to keep "temporary" actually temporary. */
export const MAX_GRACE_MINUTES = 30 * 24 * 60;

export function normalizeGraceMinutes(
  raw: number | null | undefined,
): number {
  if (raw === null || raw === undefined) return 0;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), MAX_GRACE_MINUTES);
}

/**
 * Rotate a key: generate a new plaintext + hash + prefix in place while
 * preserving id, name, created_at, last_used_at, and use_count so dashboards
 * and audit logs stay continuous. Revoked keys cannot be rotated; callers
 * should issue a fresh key instead. Returns the new plaintext exactly once.
 *
 * When `graceMinutes > 0`, the previous secret keeps working until the grace
 * window elapses so callers can roll out the new key with zero downtime.
 * `graceMinutes = 0` is the legacy hard-cutover behaviour.
 */
export async function rotateKey(
  id: string,
  graceMinutes: number = 0,
): Promise<NewApiKey | null> {
  let issued: NewApiKey | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const k = s.keys.find((k) => k.id === id);
    if (!k || k.revoked || isExpired(k)) return;
    const grace = normalizeGraceMinutes(graceMinutes);
    const oldHash = k.hash;
    const oldPrefix = k.prefix;
    const plaintext = "adh_" + randomBytes(24).toString("base64url");
    k.prefix = plaintext.slice(0, 12);
    k.hash = hashKey(plaintext);
    k.rotated_at = Date.now();
    if (grace > 0) {
      k.previous_hash = oldHash;
      k.previous_prefix = oldPrefix;
      k.previous_expires_at = k.rotated_at + grace * 60 * 1000;
    } else {
      k.previous_hash = null;
      k.previous_prefix = null;
      k.previous_expires_at = null;
    }
    issued = { record: { ...k }, plaintext };
    await writeStore(s);
  });
  await writeQueue;
  return issued;
}

/**
 * Immediately end an active grace window so the previous secret stops working.
 * Returns the updated public view, or `null` if the key is missing or had no
 * active grace to revoke.
 */
export async function revokePreviousSecret(
  id: string,
): Promise<ApiKeyRecord | null> {
  let updated: ApiKeyRecord | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const k = s.keys.find((k) => k.id === id);
    if (!k) return;
    if (!hasActiveGrace(k)) return;
    k.previous_hash = null;
    k.previous_prefix = null;
    k.previous_expires_at = null;
    updated = { ...k };
    await writeStore(s);
  });
  await writeQueue;
  return updated;
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
export interface VerifyResult {
  record: ApiKeyRecord;
  /** True when the caller authenticated with the previous (grace) secret. */
  viaGrace: boolean;
}

export async function verifyKey(plaintext: string): Promise<ApiKeyRecord | null> {
  const r = await verifyKeyDetailed(plaintext);
  return r ? r.record : null;
}

/**
 * Like `verifyKey` but also reports whether the request authenticated via the
 * previous-secret grace window. Used by `/v1/keys/me` so callers can tell
 * their integration is still on the old secret and finish rolling out.
 */
export async function verifyKeyDetailed(
  plaintext: string,
): Promise<VerifyResult | null> {
  if (!plaintext || typeof plaintext !== "string") return null;
  const h = hashKey(plaintext);
  let result: VerifyResult | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const now = Date.now();
    // Try the current secret first, then the grace secret.
    let viaGrace = false;
    let k = s.keys.find((k) => !k.revoked && !isExpired(k, now) && k.hash === h);
    if (!k) {
      k = s.keys.find(
        (k) =>
          !k.revoked &&
          !isExpired(k, now) &&
          hasActiveGrace(k, now) &&
          k.previous_hash === h,
      );
      if (k) viaGrace = true;
    }
    if (!k) return;
    k.last_used_at = now;
    k.use_count += 1;
    // Opportunistically clear an expired grace window we just stepped past.
    if (
      !viaGrace &&
      k.previous_expires_at &&
      k.previous_expires_at <= now
    ) {
      k.previous_hash = null;
      k.previous_prefix = null;
      k.previous_expires_at = null;
    }
    result = { record: { ...k }, viaGrace };
    await writeStore(s);
  });
  await writeQueue;
  return result;
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
