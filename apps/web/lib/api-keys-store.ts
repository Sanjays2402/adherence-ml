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

export const ALL_SCOPES = ["predict", "read", "webhooks", "audit"] as const;

/**
 * Per-key client IP allowlist. Stored as a list of CIDR strings (IPv4 or IPv6).
 * Empty/missing list means the key works from any source IP (subject to the
 * separate workspace-level IP allowlist enforced upstream). When set, each
 * inbound request authenticated by this key MUST come from an IP that falls
 * inside at least one of the listed CIDRs, otherwise the route returns 403.
 *
 * This is a defence-in-depth control independent of the workspace allowlist:
 * a leaked key still cannot be used from an attacker's IP if the rightful
 * owner has pinned the key to (for example) `10.0.0.0/8` or a single
 * `203.0.113.42/32` egress NAT.
 */
export const MAX_KEY_CIDRS = 32;

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  // force unsigned
  return n >>> 0;
}

function parseIpv6(ip: string): bigint | null {
  // strip zone id, e.g. fe80::1%eth0
  const clean = ip.split("%")[0];
  // reject anything that is not hex / : / .
  if (!/^[0-9a-fA-F:.]+$/.test(clean)) return null;
  // `:::` (or more) is never valid: `::` already represents the gap and any
  // adjacent `:` would make an empty group on either side of it.
  if (clean.includes(":::")) return null;
  let head: string;
  let tail: string;
  if (clean.includes("::")) {
    const [h, t] = clean.split("::");
    if (clean.split("::").length > 2) return null;
    head = h;
    tail = t;
  } else {
    head = clean;
    tail = "";
  }
  const expand = (s: string): string[] => (s === "" ? [] : s.split(":"));
  let h = expand(head);
  let t = expand(tail);
  // handle embedded ipv4, e.g. ::ffff:192.0.2.1
  const mixIn = (arr: string[]) => {
    if (arr.length === 0) return arr;
    const last = arr[arr.length - 1];
    if (last.includes(".")) {
      const v4 = parseIpv4(last);
      if (v4 == null) return null;
      arr.pop();
      arr.push(((v4 >>> 16) & 0xffff).toString(16));
      arr.push((v4 & 0xffff).toString(16));
    }
    return arr;
  };
  const hh = mixIn(h);
  const tt = mixIn(t);
  if (!hh || !tt) return null;
  const missing = 8 - hh.length - tt.length;
  if (missing < 0) return null;
  if (missing > 0 && !clean.includes("::")) return null;
  const groups = [...hh, ...Array(missing).fill("0"), ...tt];
  if (groups.length !== 8) return null;
  let acc = 0n;
  for (const g of groups) {
    if (g.length > 4 || !/^[0-9a-fA-F]*$/.test(g)) return null;
    acc = (acc << 16n) | BigInt(parseInt(g || "0", 16));
  }
  return acc;
}

/**
 * Parse a CIDR string into a normalized canonical form, or return null when
 * the input is not a syntactically valid IPv4/IPv6 CIDR. A bare IP (no `/`)
 * is treated as a host route: `/32` for v4, `/128` for v6.
 */
export function normalizeCidr(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let ipPart = trimmed;
  let bits: number | null = null;
  const slash = trimmed.indexOf("/");
  if (slash >= 0) {
    ipPart = trimmed.slice(0, slash);
    const b = trimmed.slice(slash + 1);
    if (!/^\d+$/.test(b)) return null;
    bits = Number(b);
  }
  if (ipPart.includes(":")) {
    const v = parseIpv6(ipPart);
    if (v == null) return null;
    if (bits == null) bits = 128;
    if (bits < 0 || bits > 128) return null;
    return `${ipPart.toLowerCase()}/${bits}`;
  }
  const v = parseIpv4(ipPart);
  if (v == null) return null;
  if (bits == null) bits = 32;
  if (bits < 0 || bits > 32) return null;
  return `${ipPart}/${bits}`;
}

export function normalizeAllowedCidrs(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const n = normalizeCidr(item);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_KEY_CIDRS) break;
  }
  // empty list (caller explicitly cleared) means "any IP allowed"; treat as null
  return out.length === 0 ? null : out;
}

/**
 * Return true when `ip` falls inside `cidr`. Mismatched families (v4 vs v6)
 * never match. Malformed inputs return false.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash < 0) return false;
  const base = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isFinite(bits) || bits < 0) return false;
  const isV6 = ip.includes(":") || base.includes(":");
  if (isV6) {
    if (!ip.includes(":") || !base.includes(":")) return false;
    if (bits > 128) return false;
    const a = parseIpv6(ip);
    const b = parseIpv6(base);
    if (a == null || b == null) return false;
    if (bits === 0) return true;
    const shift = BigInt(128 - bits);
    return (a >> shift) === (b >> shift);
  }
  if (bits > 32) return false;
  const a = parseIpv4(ip);
  const b = parseIpv4(base);
  if (a == null || b == null) return false;
  if (bits === 0) return true;
  const shift = 32 - bits;
  return (a >>> shift) === (b >>> shift);
}

/**
 * Extract the best-guess client IP from request headers. Honors the standard
 * `x-forwarded-for` chain (leftmost is the original client) and falls back
 * to `x-real-ip`. Returns an empty string when no candidate is available.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "";
}

/**
 * Decide whether a key is permitted to be used from the given client IP.
 * - When the key has no allowed_cidrs list, returns true (any source allowed).
 * - When the list is non-empty, the client IP must fall inside at least one
 *   CIDR. An empty client IP (proxy didn't supply one) with a non-empty
 *   allowlist returns false: fail closed.
 */
export function ipAllowedForKey(
  rec: Pick<ApiKeyRecord, "allowed_cidrs">,
  clientIp: string,
): boolean {
  const list = rec.allowed_cidrs;
  if (!Array.isArray(list) || list.length === 0) return true;
  if (!clientIp) return false;
  for (const cidr of list) {
    if (ipInCidr(clientIp, cidr)) return true;
  }
  return false;
}

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
  /**
   * Optional per-key per-minute burst rate limit. When set to a positive
   * integer, the key is limited to this many calls in any rolling 60-second
   * window in addition to the daily quota. `null` or omitted means no
   * per-minute cap. This is the small companion to `daily_quota`: it lets
   * an enterprise customer protect a production tenant from a runaway
   * client without dropping the daily ceiling.
   */
  burst_rpm?: number | null;
  /**
   * Optional per-key client IP allowlist as a list of normalized CIDRs.
   * When set and non-empty, the key only authenticates requests whose
   * client IP falls inside at least one entry. See `ipAllowedForKey`.
   */
  allowed_cidrs?: string[] | null;
  /**
   * Display-only attribution for the most recent successful verify. Lets
   * the admin panel surface 'where was this key just used from?' without
   * trawling request logs. Neither field is used for access control;
   * IP enforcement is handled by `allowed_cidrs` above.
   */
  last_used_ip?: string | null;
  last_used_user_agent?: string | null;
  /**
   * Why this key was revoked, captured at revocation time. Forensics and
   * SOC2 CC6.1 / ISO 27001 A.9.2.6 want a recorded justification for every
   * credential lifecycle change, not just a boolean flag. `null` on keys
   * revoked before this field existed (treat as `unspecified` in the UI).
   */
  revoked_reason?: RevokeReason | null;
  /** Free-text operator note (max 280 chars), optional context for the reason. */
  revoked_note?: string | null;
  /** Epoch ms when revocation happened. */
  revoked_at?: number | null;
  /** Dashboard user id that triggered the revoke. `null` for system/CLI paths. */
  revoked_by_user_id?: string | null;
  /** Email at revoke time, snapshotted so a later user-rename does not lose attribution. */
  revoked_by_email?: string | null;
}

/**
 * Reasons an operator can give when revoking an API key. The set is
 * intentionally small so dashboards, exports, and audit queries can pivot
 * cleanly. `unspecified` exists for legacy rows and scripted/CLI revokes
 * that pre-date this field; the dashboard requires an explicit choice.
 */
export const REVOKE_REASONS = [
  "compromised",
  "rotated",
  "employee_offboarded",
  "unused",
  "vendor_offboarded",
  "policy_violation",
  "other",
  "unspecified",
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** Reasons a human operator is allowed to pick from the UI / API. */
export const SELECTABLE_REVOKE_REASONS: ReadonlyArray<RevokeReason> = REVOKE_REASONS.filter(
  (r) => r !== "unspecified",
);

/** Cap on the free-text note attached to a revoke. */
export const REVOKE_NOTE_MAX = 280;

export interface RevokeOptions {
  reason?: RevokeReason | null;
  note?: string | null;
  actor?: { user_id: string | null; email: string | null } | null;
}

export interface RevokeResult {
  ok: boolean;
  /** `already_revoked` lets the route return 409 instead of pretending it worked. */
  status: "revoked" | "already_revoked" | "not_found";
  before: ApiKeyRecord | null;
  after: ApiKeyRecord | null;
}

/** Normalize a user-supplied daily quota value into a stored field. */
export function normalizeDailyQuota(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // cap at 10M/day to avoid silly values
  return Math.min(Math.floor(n), 10_000_000);
}

/**
 * Maximum per-key burst rate, in requests per minute. 60_000 rpm = 1000 rps,
 * well past anything a single sane caller should need; the workspace plan
 * still applies on top.
 */
export const MAX_BURST_RPM = 60_000;

/** Normalize a user-supplied per-minute burst limit into a stored field. */
export function normalizeBurstRpm(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), MAX_BURST_RPM);
}

/** True when the key carries a non-null `expires_at` that has already passed. */
export function isExpired(
  rec: Pick<ApiKeyRecord, "expires_at">,
  now: number = Date.now(),
): boolean {
  return typeof rec.expires_at === "number" && rec.expires_at > 0 && rec.expires_at <= now;
}

/**
 * Maximum lookahead window the expiring-soon endpoint will honour.
 * 365 days lets operators run a yearly compliance review without
 * needing to widen it further; anything beyond just leaks every key.
 */
export const MAX_EXPIRING_SOON_WINDOW_DAYS = 365;

/**
 * Default lookahead used by the UI banner. Two weeks is what most
 * SREs say is the smallest window that lets them schedule a rotation
 * change-management window without firefighting.
 */
export const DEFAULT_EXPIRING_SOON_WINDOW_DAYS = 14;

export interface ExpiringKey {
  id: string;
  name: string;
  prefix: string;
  scopes: KeyScope[];
  expires_at: number;
  days_remaining: number;
  last_used_at: number | null;
  last_used_ip: string | null;
}

/**
 * Return all live (not revoked, not already expired) keys whose
 * `expires_at` falls within `windowDays` from `now`, sorted by the
 * key nearest to expiry first. Revoked keys and keys with no
 * `expires_at` are skipped: only active keys that will silently
 * stop working soon are reported.
 */
export function pickExpiringSoon(
  keys: ApiKeyRecord[],
  windowDays: number,
  now: number = Date.now(),
): ExpiringKey[] {
  const w = Math.max(
    1,
    Math.min(MAX_EXPIRING_SOON_WINDOW_DAYS, Math.floor(windowDays)),
  );
  const horizon = now + w * 24 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const out: ExpiringKey[] = [];
  for (const k of keys) {
    if (k.revoked) continue;
    if (typeof k.expires_at !== "number" || k.expires_at <= 0) continue;
    if (k.expires_at <= now) continue; // already expired, not "soon"
    if (k.expires_at > horizon) continue;
    out.push({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: scopesOf(k),
      expires_at: k.expires_at,
      days_remaining: Math.max(0, Math.ceil((k.expires_at - now) / dayMs)),
      last_used_at: k.last_used_at,
      last_used_ip: k.last_used_ip ?? null,
    });
  }
  out.sort((a, b) => a.expires_at - b.expires_at);
  return out;
}

/** Convenience: load keys from disk then run pickExpiringSoon. */
export async function findExpiringSoon(
  windowDays: number = DEFAULT_EXPIRING_SOON_WINDOW_DAYS,
  now: number = Date.now(),
): Promise<ExpiringKey[]> {
  const keys = await listKeys();
  return pickExpiringSoon(keys, windowDays, now);
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
    burst_rpm: k.burst_rpm ?? null,
    allowed_cidrs: Array.isArray(k.allowed_cidrs) ? [...k.allowed_cidrs] : null,
    last_used_ip: k.last_used_ip ?? null,
    last_used_user_agent: k.last_used_user_agent ?? null,
    revoked_reason: k.revoked_reason ?? (k.revoked ? "unspecified" : null),
    revoked_note: k.revoked_note ?? null,
    revoked_at: k.revoked_at ?? null,
    revoked_by_email: k.revoked_by_email ?? null,
  };
}

/** Normalize and validate a user-supplied revoke note. Returns null if empty. */
export function normalizeRevokeNote(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, REVOKE_NOTE_MAX);
}

/**
 * Update mutable fields on an existing key (name, scopes, daily_quota).
 * Returns the updated record, or null if not found / revoked.
 * Only fields explicitly provided in `patch` are touched.
 */
export async function updateKey(
  id: string,
  patch: {
    name?: string;
    scopes?: KeyScope[];
    daily_quota?: number | null;
    burst_rpm?: number | null;
    allowed_cidrs?: string[] | null;
  },
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
    if (patch.burst_rpm !== undefined) {
      k.burst_rpm = normalizeBurstRpm(patch.burst_rpm);
    }
    if (patch.allowed_cidrs !== undefined) {
      // patch.allowed_cidrs === null clears the pin; an array is normalized
      if (patch.allowed_cidrs === null) {
        k.allowed_cidrs = null;
      } else {
        k.allowed_cidrs = normalizeAllowedCidrs(patch.allowed_cidrs);
      }
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
  allowedCidrs: string[] | null = null,
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
    burst_rpm: null,
    allowed_cidrs: normalizeAllowedCidrs(allowedCidrs),
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
export async function rotateKey(
  id: string,
  opts?: { capTtlDays?: number | null },
): Promise<NewApiKey | null> {
  let issued: NewApiKey | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const k = s.keys.find((k) => k.id === id);
    if (!k || k.revoked || isExpired(k)) return;
    const plaintext = "adh_" + randomBytes(24).toString("base64url");
    k.prefix = plaintext.slice(0, 12);
    k.hash = hashKey(plaintext);
    k.rotated_at = Date.now();
    // SOC2 control: when a workspace TTL cap is in force, rotation must
    // re-stamp expires_at so a key cannot outlive the cap. We push the
    // expiry forward to (now + cap) but never extend it past an existing
    // earlier expires_at unless the operator explicitly opted in by
    // calling rotation (rotation IS the renewal action).
    const cap = opts?.capTtlDays;
    if (typeof cap === "number" && cap > 0) {
      const next = ttlToExpiresAt(cap);
      k.expires_at = next;
    }
    issued = { record: { ...k }, plaintext };
    await writeStore(s);
  });
  await writeQueue;
  return issued;
}

/**
 * Revoke an API key.
 *
 * Backwards compatible: `await revokeKey(id)` still returns `boolean`.
 * Pass `opts` to capture forensic metadata (reason, note, acting user).
 * Already-revoked keys are NOT flipped a second time, and the function
 * returns `false` so callers can distinguish first-revoke from no-op.
 */
export async function revokeKey(
  id: string,
  opts: RevokeOptions = {},
): Promise<boolean> {
  const result = await revokeKeyDetailed(id, opts);
  return result.status === "revoked";
}

/**
 * Like `revokeKey` but returns the full transition so the API layer can
 * write a meaningful audit entry (before/after diff) and return 404 vs
 * 409 vs 200 correctly.
 */
export async function revokeKeyDetailed(
  id: string,
  opts: RevokeOptions = {},
): Promise<RevokeResult> {
  let result: RevokeResult = { ok: false, status: "not_found", before: null, after: null };
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const k = s.keys.find((k) => k.id === id);
    if (!k) return;
    const before: ApiKeyRecord = { ...k };
    if (k.revoked) {
      result = { ok: false, status: "already_revoked", before, after: { ...k } };
      return;
    }
    const reason: RevokeReason = opts.reason && REVOKE_REASONS.includes(opts.reason)
      ? opts.reason
      : "unspecified";
    k.revoked = true;
    k.revoked_reason = reason;
    k.revoked_note = normalizeRevokeNote(opts.note);
    k.revoked_at = Date.now();
    k.revoked_by_user_id = opts.actor?.user_id ?? null;
    k.revoked_by_email = opts.actor?.email ?? null;
    await writeStore(s);
    result = { ok: true, status: "revoked", before, after: { ...k } };
  });
  await writeQueue;
  return result;
}

/**
 * Validate a presented key. Returns the matching record on success.
 * Records usage (last_used_at, use_count, optional last_used_ip /
 * last_used_user_agent) as a side effect.
 */
export async function verifyKey(
  plaintext: string,
  meta?: { client_ip?: string | null; user_agent?: string | null },
): Promise<ApiKeyRecord | null> {
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
    if (meta) {
      const ip = (meta.client_ip ?? "").trim();
      const ua = (meta.user_agent ?? "").trim();
      if (ip) k.last_used_ip = ip.slice(0, 64);
      if (ua) k.last_used_user_agent = ua.slice(0, 256);
    }
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
