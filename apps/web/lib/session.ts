/**
 * Signed-cookie sessions. No external deps; HMAC-SHA256 over the payload.
 *
 * Payload format: base64url(JSON({uid, eml, iat, exp})) + "." + base64url(hmac)
 *
 * Secret comes from ADHERENCE_SESSION_SECRET. In dev a stable fallback is
 * derived from the working directory so logins survive restarts without
 * forcing the developer to set an env var; production deployments must set
 * the env var or sessions will not transfer across pods.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import {
  getUserById,
  currentSessionGen,
  type UserRecord,
} from "./users-store";

export const SESSION_COOKIE = "adh_session";
export const MFA_PENDING_COOKIE = "adh_mfa_pending";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MFA_PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes to enter a code

interface MfaPendingPayload {
  uid: string;
  eml: string;
  iat: number;
  exp: number;
  /** Same-origin path to bounce the user to after successful 2FA. */
  next?: string;
}

interface SessionPayload {
  uid: string;
  eml: string;
  iat: number;
  exp: number;
  /**
   * Session generation. Cookies whose gen is below the user's current
   * session_gen are rejected, enabling force-logout-all-sessions.
   * Optional for backward compatibility with cookies minted before this
   * field existed (those are treated as gen 1).
   */
  gen?: number;
}

function getSecret(): Buffer {
  const fromEnv = process.env.ADHERENCE_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, "utf8");
  // Dev fallback: stable per-checkout, never used in production unless the
  // operator explicitly omits the env var (and we still warn).
  if (process.env.NODE_ENV === "production" && !fromEnv) {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth] ADHERENCE_SESSION_SECRET is not set; sessions are insecure.",
    );
  }
  return createHash("sha256")
    .update("adherence-ml-dev-fallback:" + process.cwd())
    .digest();
}

function b64uEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b.toString("base64url");
}

function b64uDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function signSession(payload: SessionPayload): string {
  const body = b64uEncode(JSON.stringify(payload));
  const mac = createHmac("sha256", getSecret()).update(body).digest();
  return body + "." + b64uEncode(mac);
}

export function verifySession(raw: string | undefined): SessionPayload | null {
  if (!raw || typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  let actual: Buffer;
  try {
    actual = b64uDecode(sig);
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64uDecode(body).toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.uid !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < Date.now()) return null;
  return payload;
}

export function buildSession(user: UserRecord): {
  cookie: string;
  expires: Date;
} {
  const now = Date.now();
  const payload: SessionPayload = {
    uid: user.id,
    eml: user.email,
    iat: now,
    exp: now + SESSION_TTL_MS,
    gen: currentSessionGen(user),
  };
  return { cookie: signSession(payload), expires: new Date(payload.exp) };
}

/** Cookie attributes object used by routes that re-mint the session. */
export function sessionCookieOptions(expires: Date) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    expires,
  };
}

export interface SessionContext {
  user: UserRecord;
  payload: SessionPayload;
}

/**
 * Read the session from the request cookies (server components & route handlers).
 * Returns null when unauthenticated.
 */
export async function getSession(req?: NextRequest): Promise<SessionContext | null> {
  let raw: string | undefined;
  if (req) {
    raw = req.cookies.get(SESSION_COOKIE)?.value;
  } else {
    const jar = await cookies();
    raw = jar.get(SESSION_COOKIE)?.value;
  }
  const payload = verifySession(raw);
  if (!payload) return null;
  const user = await getUserById(payload.uid);
  if (!user) return null;
  // Reject cookies issued before the user's current session generation
  // (force-logout-all). Missing `gen` in a payload is treated as gen 1
  // so legacy cookies keep working until the user explicitly revokes.
  const cookieGen = typeof payload.gen === "number" ? payload.gen : 1;
  if (cookieGen < currentSessionGen(user)) return null;
  return { user, payload };
}

export function sessionCookieAttributes(expires: Date, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`, // value filled by caller
    `Path=/`,
    `Expires=${expires.toUTCString()}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// MFA pending sessions: short-lived signed cookie issued at login when the
// user has TOTP enabled. Exchanged for a real session by /api/auth/2fa/verify.
// ---------------------------------------------------------------------------

function signMfaPending(payload: MfaPendingPayload): string {
  const body = b64uEncode(JSON.stringify(payload));
  const mac = createHmac("sha256", getSecret())
    .update("mfa:" + body)
    .digest();
  return body + "." + b64uEncode(mac);
}

export function verifyMfaPending(raw: string | undefined): MfaPendingPayload | null {
  if (!raw || typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", getSecret())
    .update("mfa:" + body)
    .digest();
  let actual: Buffer;
  try {
    actual = b64uDecode(sig);
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  let payload: MfaPendingPayload;
  try {
    payload = JSON.parse(b64uDecode(body).toString("utf8")) as MfaPendingPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.uid !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < Date.now()) return null;
  return payload;
}

export function buildMfaPending(
  user: UserRecord,
  next: string | undefined,
): { cookie: string; expires: Date } {
  const now = Date.now();
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const payload: MfaPendingPayload = {
    uid: user.id,
    eml: user.email,
    iat: now,
    exp: now + MFA_PENDING_TTL_MS,
    next: safeNext,
  };
  return { cookie: signMfaPending(payload), expires: new Date(payload.exp) };
}

/** Read a pending-MFA session for the /verify-2fa flow. */
export async function getPendingMfa(req?: NextRequest): Promise<{
  user: UserRecord;
  payload: MfaPendingPayload;
} | null> {
  let raw: string | undefined;
  if (req) {
    raw = req.cookies.get(MFA_PENDING_COOKIE)?.value;
  } else {
    const jar = await cookies();
    raw = jar.get(MFA_PENDING_COOKIE)?.value;
  }
  const payload = verifyMfaPending(raw);
  if (!payload) return null;
  const user = await getUserById(payload.uid);
  if (!user) return null;
  return { user, payload };
}
