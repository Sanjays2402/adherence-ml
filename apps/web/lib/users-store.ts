/**
 * Users + magic-link tokens store. File-backed JSON, no external deps.
 * Mirrors the runs/api-keys/webhooks stores so it deploys with zero infra.
 *
 * Tokens are stored hashed (sha256). Plaintext lives only in the email link.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

export interface UserRecord {
  id: string;            // stable internal id
  email: string;         // lowercased
  created_at: number;
  last_login_at: number | null;
  /** TOTP secret in base32. Set during 2FA setup, cleared on disable. */
  totp_secret?: string | null;
  /** True once the user has verified a code from their authenticator app. */
  totp_enabled?: boolean;
  /** Hashed (sha256) one-time recovery codes. Cleared as they are used. */
  recovery_code_hashes?: string[];
  /** Unix ms when 2FA was last enabled or disabled, for audit display. */
  totp_updated_at?: number | null;
  /**
   * Session generation counter. Incremented when the user revokes all
   * outstanding sessions; cookies whose `gen` claim is below this value
   * are rejected by getSession. Defaults to 1 for users created before
   * this field existed (legacy cookies without a `gen` claim still verify).
   */
  session_gen?: number;
  /** Unix ms when sessions were last force-revoked. */
  sessions_revoked_at?: number | null;
}

export interface MagicTokenRecord {
  hash: string;          // sha256(plaintext)
  email: string;         // lowercased
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

interface Store {
  version: 1;
  users: UserRecord[];
  tokens: MagicTokenRecord[];
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "users.json");

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return { version: 1, users: [], tokens: [] };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1) return { version: 1, users: [], tokens: [] };
    parsed.users = Array.isArray(parsed.users) ? parsed.users : [];
    parsed.tokens = Array.isArray(parsed.tokens) ? parsed.tokens : [];
    return parsed;
  } catch {
    return { version: 1, users: [], tokens: [] };
  }
}

async function writeStore(store: Store): Promise<void> {
  ensureDir();
  const body = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(STORE_PATH, body, "utf8"));
  return writeQueue;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  // intentionally permissive; real validation happens via the magic link
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function newUserId(): string {
  return "u_" + randomBytes(8).toString("base64url").slice(0, 12);
}

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Create (or refresh) a single-use magic-link token for the given email.
 * Returns plaintext, which must be embedded in the link sent to the user.
 */
export async function issueMagicToken(email: string): Promise<{
  token: string;
  expires_at: number;
}> {
  const e = normalizeEmail(email);
  const store = await readStore();
  // garbage-collect expired tokens
  const now = Date.now();
  store.tokens = store.tokens.filter((t) => t.expires_at > now && !t.consumed_at);

  const plaintext = randomBytes(24).toString("base64url"); // 32-char url-safe
  const rec: MagicTokenRecord = {
    hash: hashToken(plaintext),
    email: e,
    created_at: now,
    expires_at: now + TOKEN_TTL_MS,
    consumed_at: null,
  };
  store.tokens.push(rec);
  await writeStore(store);
  return { token: plaintext, expires_at: rec.expires_at };
}

/**
 * Verify and consume a magic-link token. On success, returns the User
 * (creating it if first-time). Returns null on any failure (expired,
 * unknown, or already consumed).
 */
export async function consumeMagicToken(plaintext: string): Promise<UserRecord | null> {
  if (!plaintext || typeof plaintext !== "string") return null;
  const h = hashToken(plaintext);
  const store = await readStore();
  const now = Date.now();
  const tok = store.tokens.find((t) => t.hash === h);
  if (!tok) return null;
  if (tok.consumed_at) return null;
  if (tok.expires_at < now) return null;

  tok.consumed_at = now;

  let user = store.users.find((u) => u.email === tok.email);
  if (!user) {
    user = {
      id: newUserId(),
      email: tok.email,
      created_at: now,
      last_login_at: now,
    };
    store.users.push(user);
  } else {
    user.last_login_at = now;
  }
  await writeStore(store);
  return user;
}

/**
 * Get or create a user by email. Used by OAuth providers (GitHub, etc.)
 * where the email is already verified by the IdP, so no magic link is
 * required. Updates last_login_at on every call.
 */
export async function getOrCreateUserByEmail(email: string): Promise<UserRecord> {
  const e = normalizeEmail(email);
  const store = await readStore();
  const now = Date.now();
  let user = store.users.find((u) => u.email === e);
  if (!user) {
    user = {
      id: newUserId(),
      email: e,
      created_at: now,
      last_login_at: now,
    };
    store.users.push(user);
  } else {
    user.last_login_at = now;
  }
  await writeStore(store);
  return user;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  if (!id) return null;
  const store = await readStore();
  return store.users.find((u) => u.id === id) ?? null;
}

/** Current session generation for a user; 1 if unset (legacy). */
export function currentSessionGen(user: UserRecord | null | undefined): number {
  if (!user) return 1;
  const g = user.session_gen;
  return typeof g === "number" && g >= 1 ? g : 1;
}

/**
 * Force-revoke every outstanding session cookie for this user by bumping
 * the session generation. Returns the updated user.
 */
export async function bumpSessionGen(
  userId: string,
): Promise<UserRecord | null> {
  const store = await readStore();
  const u = store.users.find((x) => x.id === userId);
  if (!u) return null;
  u.session_gen = currentSessionGen(u) + 1;
  u.sessions_revoked_at = Date.now();
  await writeStore(store);
  return u;
}

// Test hooks - exported so the smoke test can reset state.
export async function _resetForTests(): Promise<void> {
  await writeStore({ version: 1, users: [], tokens: [] });
}

// ---------------------------------------------------------------------------
// Two-factor auth (TOTP)
// ---------------------------------------------------------------------------

function hashRecoveryCode(plain: string): string {
  return createHash("sha256").update(plain.trim().toLowerCase()).digest("hex");
}

/**
 * Generate N human-friendly recovery codes (xxxx-xxxx, base32 alphabet).
 * Returns plaintext for one-time display to the user.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // omit confusables
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const buf = randomBytes(8);
    let chars = "";
    for (const b of buf) chars += alphabet[b % alphabet.length];
    out.push(`${chars.slice(0, 4)}-${chars.slice(4, 8)}`);
  }
  return out;
}

/**
 * Stage a pending TOTP secret on the user. The secret is stored immediately
 * so a later /enable call can verify against it, but `totp_enabled` stays
 * false until the user confirms a code.
 */
export async function setPendingTotpSecret(
  userId: string,
  secretBase32: string,
): Promise<UserRecord | null> {
  const store = await readStore();
  const user = store.users.find((u) => u.id === userId);
  if (!user) return null;
  user.totp_secret = secretBase32;
  user.totp_enabled = false;
  user.recovery_code_hashes = [];
  await writeStore(store);
  return user;
}

/**
 * Mark TOTP as enabled and persist the hashed recovery codes. The caller
 * must have already verified a fresh code against the pending secret.
 */
export async function enableTotp(
  userId: string,
  recoveryCodesPlain: string[],
): Promise<UserRecord | null> {
  const store = await readStore();
  const user = store.users.find((u) => u.id === userId);
  if (!user || !user.totp_secret) return null;
  user.totp_enabled = true;
  user.recovery_code_hashes = recoveryCodesPlain.map(hashRecoveryCode);
  user.totp_updated_at = Date.now();
  await writeStore(store);
  return user;
}

/** Fully disable TOTP and forget all secrets/codes. */
export async function disableTotp(userId: string): Promise<UserRecord | null> {
  const store = await readStore();
  const user = store.users.find((u) => u.id === userId);
  if (!user) return null;
  user.totp_secret = null;
  user.totp_enabled = false;
  user.recovery_code_hashes = [];
  user.totp_updated_at = Date.now();
  await writeStore(store);
  return user;
}

/**
 * Consume a recovery code if it matches one of the hashes on the user.
 * Returns true on success; the matching code is removed from the user.
 */
export async function consumeRecoveryCode(
  userId: string,
  submitted: string,
): Promise<boolean> {
  if (!submitted) return false;
  const want = hashRecoveryCode(submitted);
  const store = await readStore();
  const user = store.users.find((u) => u.id === userId);
  if (!user || !user.recovery_code_hashes?.length) return false;
  const idx = user.recovery_code_hashes.indexOf(want);
  if (idx < 0) return false;
  user.recovery_code_hashes.splice(idx, 1);
  await writeStore(store);
  return true;
}

/** True if the user has completed TOTP setup. */
export function hasTotpEnabled(user: UserRecord | null | undefined): boolean {
  return Boolean(user && user.totp_enabled && user.totp_secret);
}

