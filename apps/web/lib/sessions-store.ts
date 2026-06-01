/**
 * Active sessions store. File-backed JSON, mirrors the other stores so it
 * deploys with zero infra.
 *
 * Each successful sign-in mints a session record keyed by a random `sid` and
 * the `sid` is embedded in the cookie payload. `getSession()` enforces:
 *
 *   - the sid still exists in the store
 *   - the record is not revoked
 *   - the user_id matches the cookie's uid (defence in depth)
 *
 * On every authenticated request the record's `last_seen_at` and last IP/UA
 * are refreshed (debounced to one write per minute per session). Owners can
 * list their active sessions in /settings/sessions and revoke any one of
 * them; the cookie tied to that sid stops verifying on its next request.
 *
 * Sessions whose `expires_at` has passed are pruned lazily on read.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface SessionRecord {
  sid: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
  /** Short human label, e.g. "magic-link", "sso", "github", "2fa". */
  label: string;
  revoked: boolean;
  revoked_at: number | null;
  /**
   * Last time this session proved possession of a second factor (TOTP or
   * recovery code). Set at login when 2FA was used, refreshed by the
   * step-up endpoint. Sensitive actions (api key issue/rotate/revoke,
   * ownership transfer, account erasure, data wipe) require this to be
   * within STEP_UP_MAX_AGE_MS. null means "never proved on this session".
   */
  last_mfa_at?: number | null;
}

interface Store {
  version: 1;
  sessions: SessionRecord[];
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "sessions.json");

const TOUCH_DEBOUNCE_MS = 60 * 1000;

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return { version: 1, sessions: [] };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1) return { version: 1, sessions: [] };
    parsed.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    return parsed;
  } catch {
    return { version: 1, sessions: [] };
  }
}

async function writeStore(store: Store): Promise<void> {
  ensureDir();
  const body = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(STORE_PATH, body, "utf8"));
  await writeQueue;
}

function newSid(): string {
  return randomBytes(18).toString("base64url");
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = String(s).slice(0, max);
  return t.length > 0 ? t : null;
}

export interface CreateSessionInput {
  user_id: string;
  expires_at: number;
  ip?: string | null;
  user_agent?: string | null;
  label?: string;
  /** When non-null, the session is born with a proven 2FA timestamp. */
  last_mfa_at?: number | null;
}

/** Mint and persist a new session record; returns the freshly-issued sid. */
export async function createSession(input: CreateSessionInput): Promise<SessionRecord> {
  const now = Date.now();
  const rec: SessionRecord = {
    sid: newSid(),
    user_id: input.user_id,
    created_at: now,
    expires_at: input.expires_at,
    last_seen_at: now,
    ip: truncate(input.ip ?? null, 64),
    user_agent: truncate(input.user_agent ?? null, 256),
    label: input.label && input.label.length > 0 ? input.label.slice(0, 32) : "session",
    revoked: false,
    revoked_at: null,
    last_mfa_at: input.last_mfa_at ?? null,
  };
  const store = await readStore();
  store.sessions.push(rec);
  pruneExpired(store, now);
  await writeStore(store);
  return rec;
}

/** Lookup a single session by sid (used by getSession on every request). */
export async function getSessionRecord(sid: string): Promise<SessionRecord | null> {
  if (!sid || typeof sid !== "string") return null;
  const store = await readStore();
  const rec = store.sessions.find((s) => s.sid === sid);
  if (!rec) return null;
  if (rec.expires_at < Date.now()) return null;
  if (rec.revoked) return null;
  return rec;
}

/**
 * Stamp the session's last_mfa_at to `now` (or supplied timestamp). Used by
 * the 2FA step-up endpoint to renew the step-up window after a fresh TOTP.
 * Returns the updated record, or null if the session was not found / revoked.
 */
export async function markSessionMfa(
  sid: string,
  at: number = Date.now(),
): Promise<SessionRecord | null> {
  if (!sid) return null;
  const store = await readStore();
  const rec = store.sessions.find((s) => s.sid === sid);
  if (!rec || rec.revoked) return null;
  if (rec.expires_at < Date.now()) return null;
  rec.last_mfa_at = at;
  await writeStore(store);
  return rec;
}

/** Refresh last_seen_at + ip/ua, but at most once per TOUCH_DEBOUNCE_MS. */
export async function touchSession(
  sid: string,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  if (!sid) return;
  const now = Date.now();
  const store = await readStore();
  const rec = store.sessions.find((s) => s.sid === sid);
  if (!rec || rec.revoked) return;
  if (now - rec.last_seen_at < TOUCH_DEBOUNCE_MS) return;
  rec.last_seen_at = now;
  if (ip) rec.ip = truncate(ip, 64);
  if (userAgent) rec.user_agent = truncate(userAgent, 256);
  await writeStore(store);
}

/** Return non-revoked, non-expired sessions for a user, newest first. */
export async function listSessionsForUser(userId: string): Promise<SessionRecord[]> {
  const now = Date.now();
  const store = await readStore();
  return store.sessions
    .filter((s) => s.user_id === userId && !s.revoked && s.expires_at > now)
    .sort((a, b) => b.last_seen_at - a.last_seen_at);
}

/**
 * Revoke a single session by sid, scoped to a user (the API layer must pass
 * the caller's uid to prevent cross-account revocation). Returns true if a
 * record was actually flipped to revoked, false otherwise (not found, wrong
 * owner, or already revoked).
 */
export async function revokeSession(sid: string, userId: string): Promise<boolean> {
  const store = await readStore();
  const rec = store.sessions.find((s) => s.sid === sid && s.user_id === userId);
  if (!rec || rec.revoked) return false;
  rec.revoked = true;
  rec.revoked_at = Date.now();
  await writeStore(store);
  return true;
}

/** Revoke all sessions for a user except optionally one to keep. */
export async function revokeAllForUser(
  userId: string,
  keepSid: string | null,
): Promise<number> {
  const store = await readStore();
  const now = Date.now();
  let n = 0;
  for (const rec of store.sessions) {
    if (rec.user_id !== userId) continue;
    if (rec.revoked) continue;
    if (keepSid && rec.sid === keepSid) continue;
    rec.revoked = true;
    rec.revoked_at = now;
    n += 1;
  }
  if (n > 0) await writeStore(store);
  return n;
}

/** Delete every session for a user (used by account erasure). */
export async function purgeSessionsForUser(userId: string): Promise<number> {
  const store = await readStore();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.user_id !== userId);
  const removed = before - store.sessions.length;
  if (removed > 0) await writeStore(store);
  return removed;
}

function pruneExpired(store: Store, now: number): void {
  // drop sessions whose expiry has been past for more than 7 days; keep
  // recently-expired ones so the audit trail remains visible briefly.
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  store.sessions = store.sessions.filter((s) => s.expires_at > cutoff);
}
