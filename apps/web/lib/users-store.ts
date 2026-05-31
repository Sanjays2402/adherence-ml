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

// Test hooks — exported so the smoke test can reset state.
export async function _resetForTests(): Promise<void> {
  await writeStore({ version: 1, users: [], tokens: [] });
}
