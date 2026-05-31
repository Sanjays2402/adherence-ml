/**
 * Login throttle + account lockout.
 *
 * File-backed counter store (no external infra). Buckets attempts by
 * `(scope, key)` where scope is "magic_request" or "totp_verify" and
 * key is either a normalized email or a client IP. After
 * MAX_ATTEMPTS_PER_WINDOW failures inside WINDOW_MS the bucket is
 * locked for LOCKOUT_MS. Successful authentication clears the bucket
 * for the email scope so a legitimate user is not penalised for
 * historical typos.
 *
 * This protects:
 *  - the magic-link request endpoint, which otherwise lets anyone pump
 *    an arbitrary mailbox with sign-in mails (and burns email send
 *    budget),
 *  - the TOTP verify endpoint, where the 6-digit space is small enough
 *    that uncapped guessing is a real threat.
 *
 * Counters expire on read once their window is past, so the JSON file
 * stays bounded to currently-active throttles.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type ThrottleScope = "magic_request" | "totp_verify";

export interface Bucket {
  scope: ThrottleScope;
  key: string;            // normalized email or ip
  key_kind: "email" | "ip";
  fails: number;
  first_fail_at: number;  // unix ms
  last_fail_at: number;
  locked_until: number | null;
}

export interface ThrottlePolicy {
  windowMs: number;
  maxAttempts: number;
  lockoutMs: number;
}

export const DEFAULT_POLICIES: Record<ThrottleScope, ThrottlePolicy> = {
  magic_request: {
    windowMs: 10 * 60 * 1000,   // 10 minutes
    maxAttempts: 5,             // ≤5 magic-link requests per 10 min per email/ip
    lockoutMs: 15 * 60 * 1000,  // 15 minute cool-down
  },
  totp_verify: {
    windowMs: 5 * 60 * 1000,    // 5 minutes
    maxAttempts: 5,             // ≤5 wrong codes per 5 min per email/ip
    lockoutMs: 15 * 60 * 1000,
  },
};

interface Store {
  version: 1;
  buckets: Bucket[];
}

interface PolicyStore {
  version: 1;
  policies: Partial<Record<ThrottleScope, ThrottlePolicy>>;
  updated_at: number | null;
  updated_by: string | null;
}

/**
 * Hard caps so a misconfiguration cannot disable the throttle entirely
 * (e.g. maxAttempts=1_000_000) or pin a victim out forever.
 */
export const POLICY_BOUNDS = {
  windowMs: { min: 60_000, max: 24 * 60 * 60 * 1000 },         // 1 min .. 24 h
  maxAttempts: { min: 1, max: 50 },
  lockoutMs: { min: 60_000, max: 24 * 60 * 60 * 1000 },
} as const;

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "login-throttle.json");
const POLICY_PATH = path.join(DATA_DIR, "login-throttle-policy.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return { version: 1, buckets: [] };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1) return { version: 1, buckets: [] };
    parsed.buckets = Array.isArray(parsed.buckets) ? parsed.buckets : [];
    return parsed;
  } catch {
    return { version: 1, buckets: [] };
  }
}

async function writeStore(store: Store): Promise<void> {
  ensureDir();
  const body = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(STORE_PATH, body, "utf8"));
  return writeQueue;
}

function bucketId(scope: ThrottleScope, key: string): string {
  return `${scope}::${key}`;
}

function classify(key: string): "email" | "ip" {
  return key.includes("@") ? "email" : "ip";
}

// In-memory cache of overrides, refreshed from disk on every read so a
// concurrent admin update is honoured by the next throttle check without
// requiring a process restart.
let policyCache: PolicyStore | null = null;

async function readPolicyStore(): Promise<PolicyStore> {
  ensureDir();
  if (!existsSync(POLICY_PATH)) {
    return { version: 1, policies: {}, updated_at: null, updated_by: null };
  }
  try {
    const raw = await fs.readFile(POLICY_PATH, "utf8");
    const parsed = JSON.parse(raw) as PolicyStore;
    if (!parsed || parsed.version !== 1) {
      return { version: 1, policies: {}, updated_at: null, updated_by: null };
    }
    return {
      version: 1,
      policies: parsed.policies ?? {},
      updated_at: parsed.updated_at ?? null,
      updated_by: parsed.updated_by ?? null,
    };
  } catch {
    return { version: 1, policies: {}, updated_at: null, updated_by: null };
  }
}

async function writePolicyStore(store: PolicyStore): Promise<void> {
  ensureDir();
  const body = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(POLICY_PATH, body, "utf8"));
  await writeQueue;
  policyCache = store;
}

function clampPolicy(p: ThrottlePolicy): ThrottlePolicy {
  const clamp = (n: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Math.floor(n)));
  return {
    windowMs: clamp(p.windowMs, POLICY_BOUNDS.windowMs.min, POLICY_BOUNDS.windowMs.max),
    maxAttempts: clamp(p.maxAttempts, POLICY_BOUNDS.maxAttempts.min, POLICY_BOUNDS.maxAttempts.max),
    lockoutMs: clamp(p.lockoutMs, POLICY_BOUNDS.lockoutMs.min, POLICY_BOUNDS.lockoutMs.max),
  };
}

export interface EffectivePolicy extends ThrottlePolicy {
  scope: ThrottleScope;
  source: "default" | "override";
}

export interface PolicyView {
  policies: Record<ThrottleScope, EffectivePolicy>;
  bounds: typeof POLICY_BOUNDS;
  updated_at: number | null;
  updated_by: string | null;
}

/**
 * Synchronous policy lookup. Uses the cached overrides if any have been
 * loaded; the hot path on throttle checks calls `loadPolicies()` first
 * so the cache is fresh on every request.
 */
function policyFor(scope: ThrottleScope): ThrottlePolicy {
  const override = policyCache?.policies?.[scope];
  if (override) return clampPolicy(override);
  return DEFAULT_POLICIES[scope];
}

/** Refresh the in-memory policy cache from disk. */
async function loadPolicies(): Promise<PolicyStore> {
  const s = await readPolicyStore();
  policyCache = s;
  return s;
}

/** Public: return the effective per-scope policy + override metadata. */
export async function getPolicies(): Promise<PolicyView> {
  const s = await loadPolicies();
  const out: Record<ThrottleScope, EffectivePolicy> = {} as never;
  (Object.keys(DEFAULT_POLICIES) as ThrottleScope[]).forEach((scope) => {
    const override = s.policies[scope];
    out[scope] = override
      ? { scope, source: "override", ...clampPolicy(override) }
      : { scope, source: "default", ...DEFAULT_POLICIES[scope] };
  });
  return { policies: out, bounds: POLICY_BOUNDS, updated_at: s.updated_at, updated_by: s.updated_by };
}

/**
 * Public: replace overrides. Pass `null` for a scope to revert it to
 * the built-in default. Values outside POLICY_BOUNDS are clamped.
 */
export async function setPolicies(
  updates: Partial<Record<ThrottleScope, ThrottlePolicy | null>>,
  actor: string | null,
): Promise<PolicyView> {
  const current = await loadPolicies();
  const next: PolicyStore = {
    version: 1,
    policies: { ...current.policies },
    updated_at: Date.now(),
    updated_by: actor,
  };
  (Object.keys(updates) as ThrottleScope[]).forEach((scope) => {
    const val = updates[scope];
    if (val === null) {
      delete next.policies[scope];
    } else if (val) {
      next.policies[scope] = clampPolicy(val);
    }
  });
  await writePolicyStore(next);
  return getPolicies();
}

function pruneExpired(buckets: Bucket[], now: number): Bucket[] {
  return buckets.filter((b) => {
    const pol = policyFor(b.scope);
    // Drop if lockout is over AND the failure window has elapsed.
    const lockoverOk = !b.locked_until || b.locked_until <= now;
    const windowOk = now - b.last_fail_at > Math.max(pol.windowMs, pol.lockoutMs);
    if (lockoverOk && windowOk) return false;
    return true;
  });
}

export interface CheckResult {
  ok: boolean;
  locked_until: number | null;
  retry_after_ms: number;
  scope: ThrottleScope;
  key: string;
  fails: number;
}

/** Read-only check: is this scope+key currently locked? */
export async function checkLockout(
  scope: ThrottleScope,
  key: string,
): Promise<CheckResult> {
  const now = Date.now();
  await loadPolicies();
  const store = await readStore();
  const id = bucketId(scope, key);
  const b = store.buckets.find((x) => bucketId(x.scope, x.key) === id);
  if (!b || !b.locked_until || b.locked_until <= now) {
    return {
      ok: true,
      locked_until: null,
      retry_after_ms: 0,
      scope,
      key,
      fails: b?.fails ?? 0,
    };
  }
  return {
    ok: false,
    locked_until: b.locked_until,
    retry_after_ms: Math.max(0, b.locked_until - now),
    scope,
    key,
    fails: b.fails,
  };
}

/**
 * Record one failure. Returns the post-failure lockout state so the
 * caller can return a 429 with Retry-After if the threshold was crossed.
 */
export async function recordFailure(
  scope: ThrottleScope,
  key: string,
): Promise<CheckResult> {
  const now = Date.now();
  await loadPolicies();
  const pol = policyFor(scope);
  const store = await readStore();
  store.buckets = pruneExpired(store.buckets, now);
  const id = bucketId(scope, key);
  let b = store.buckets.find((x) => bucketId(x.scope, x.key) === id);
  if (!b) {
    b = {
      scope,
      key,
      key_kind: classify(key),
      fails: 0,
      first_fail_at: now,
      last_fail_at: now,
      locked_until: null,
    };
    store.buckets.push(b);
  }
  // Reset the counter if we've fallen out of the rolling window since
  // the previous failure (no penalty carry-over forever).
  if (now - b.first_fail_at > pol.windowMs) {
    b.fails = 0;
    b.first_fail_at = now;
    b.locked_until = null;
  }
  b.fails += 1;
  b.last_fail_at = now;
  if (b.fails >= pol.maxAttempts) {
    b.locked_until = now + pol.lockoutMs;
  }
  await writeStore(store);
  return {
    ok: b.locked_until ? b.locked_until <= now : true,
    locked_until: b.locked_until,
    retry_after_ms: b.locked_until ? Math.max(0, b.locked_until - now) : 0,
    scope,
    key,
    fails: b.fails,
  };
}

/** Clear the bucket for one scope+key (called on successful auth). */
export async function clearBucket(
  scope: ThrottleScope,
  key: string,
): Promise<void> {
  const store = await readStore();
  const id = bucketId(scope, key);
  const before = store.buckets.length;
  store.buckets = store.buckets.filter((x) => bucketId(x.scope, x.key) !== id);
  if (store.buckets.length !== before) await writeStore(store);
}

/** List active buckets newest first, optionally filtered to currently locked. */
export async function listBuckets(opts?: {
  onlyLocked?: boolean;
}): Promise<Bucket[]> {
  const now = Date.now();
  await loadPolicies();
  const store = await readStore();
  store.buckets = pruneExpired(store.buckets, now);
  await writeStore(store);
  let out = store.buckets.slice();
  if (opts?.onlyLocked) {
    out = out.filter((b) => b.locked_until && b.locked_until > now);
  }
  out.sort((a, b) => b.last_fail_at - a.last_fail_at);
  return out;
}

/** Admin: clear one bucket by its (scope, key). */
export async function clearByAdmin(
  scope: ThrottleScope,
  key: string,
): Promise<boolean> {
  const store = await readStore();
  const id = bucketId(scope, key);
  const before = store.buckets.length;
  store.buckets = store.buckets.filter((x) => bucketId(x.scope, x.key) !== id);
  if (store.buckets.length === before) return false;
  await writeStore(store);
  return true;
}

/** Test-only reset hook so unit tests can start from a clean store. */
export async function __resetForTests(): Promise<void> {
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) return;
  await writeStore({ version: 1, buckets: [] });
  await writePolicyStore({
    version: 1, policies: {}, updated_at: null, updated_by: null,
  });
  policyCache = null;
}

export function clientIpFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0]?.trim();
  if (first) return first;
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "0.0.0.0";
}
