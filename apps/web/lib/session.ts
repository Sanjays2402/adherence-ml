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
import { effectivePolicyForUser } from "./workspaces-store";
import {
  createSession,
  getSessionRecord,
  touchSession,
} from "./sessions-store";

/**
 * True when any workspace the user belongs to requires MFA and the user has
 * not yet enrolled a TOTP factor. Login flows that bypass the MFA challenge
 * (i.e. user has no TOTP) must refuse to mint a session in this case.
 */
export async function mfaRequiredButMissing(user: UserRecord): Promise<boolean> {
  try {
    const pol = await effectivePolicyForUser(user.id);
    if (!pol.require_mfa) return false;
    return !(user.totp_enabled && user.totp_secret);
  } catch {
    return false;
  }
}

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
  /**
   * Per-session identifier persisted in the sessions store. Lets the user
   * see active sessions and revoke any individual one. Missing on cookies
   * minted before this field shipped; those keep working until the user
   * signs in again (no forced sign-out on upgrade).
   */
  sid?: string;
}

/** Caller-supplied request context recorded with the session record. */
export interface SessionRequestContext {
  ip?: string | null;
  user_agent?: string | null;
  label?: string;
}

/** Pull ip + user-agent off a Request/Headers-like object for storage. */
export function requestContextFromHeaders(
  headers: Headers,
  label: string,
): SessionRequestContext {
  const fwd = headers.get("x-forwarded-for");
  const ip = fwd ? fwd.split(",")[0]!.trim() : headers.get("x-real-ip");
  return {
    ip: ip ?? null,
    user_agent: headers.get("user-agent"),
    label,
  };
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

export async function buildSession(
  user: UserRecord,
  ctx?: SessionRequestContext,
  opts?: { mfaProvenAt?: number | null },
): Promise<{
  cookie: string;
  expires: Date;
  sid: string;
}> {
  const now = Date.now();
  // Workspace security policy may cap session lifetime below the default.
  let ttl = SESSION_TTL_MS;
  try {
    const pol = await effectivePolicyForUser(user.id);
    if (pol.session_max_age_minutes !== null) {
      const capMs = pol.session_max_age_minutes * 60 * 1000;
      if (capMs < ttl) ttl = capMs;
    }
  } catch {
    // policy store unavailable: fall back to default TTL rather than block login.
  }
  const expMs = now + ttl;
  let sid = "";
  try {
    const rec = await createSession({
      user_id: user.id,
      expires_at: expMs,
      ip: ctx?.ip ?? null,
      user_agent: ctx?.user_agent ?? null,
      label: ctx?.label ?? "session",
      last_mfa_at: opts?.mfaProvenAt ?? null,
    });
    sid = rec.sid;
  } catch {
    // sessions store unavailable: still mint a cookie so login works, but
    // without per-session revoke. Cookie verifies via HMAC + generation.
  }
  const payload: SessionPayload = {
    uid: user.id,
    eml: user.email,
    iat: now,
    exp: expMs,
    gen: currentSessionGen(user),
    sid: sid || undefined,
  };
  return { cookie: signSession(payload), expires: new Date(payload.exp), sid };
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
    // Plain Request objects don't have NextRequest's cookies helper. Fall
    // back to parsing the Cookie header so unit tests that build a raw
    // Request continue to work.
    if (req.cookies && typeof (req.cookies as { get?: unknown }).get === "function") {
      raw = req.cookies.get(SESSION_COOKIE)?.value;
    } else {
      const cookieHeader = req.headers?.get?.("cookie") ?? "";
      const parts = cookieHeader.split(/;\s*/);
      for (const p of parts) {
        const eq = p.indexOf("=");
        if (eq <= 0) continue;
        const name = p.slice(0, eq);
        if (name === SESSION_COOKIE) {
          raw = decodeURIComponent(p.slice(eq + 1));
          break;
        }
      }
    }
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
  // Per-session revoke: if the cookie carries a sid (cookies minted after
  // this feature shipped) require the record to still be live. Missing sid
  // (legacy cookie) falls back to the generation check above.
  if (payload.sid) {
    const rec = await getSessionRecord(payload.sid);
    if (!rec || rec.user_id !== payload.uid) return null;
    // Best-effort touch; never fail the request if disk write hiccups.
    try {
      const hdrs = req ? req.headers : null;
      const fwd = hdrs?.get("x-forwarded-for") ?? null;
      const ip = fwd ? fwd.split(",")[0]!.trim() : hdrs?.get("x-real-ip") ?? null;
      const ua = hdrs?.get("user-agent") ?? null;
      await touchSession(payload.sid, ip, ua);
    } catch {
      // ignore
    }
  }
  // Re-evaluate workspace security policy on every request so tightening the
  // session_max_age_minutes invalidates already-minted long-lived cookies.
  try {
    const pol = await effectivePolicyForUser(user.id);
    if (pol.session_max_age_minutes !== null) {
      const ageMs = Date.now() - payload.iat;
      if (ageMs > pol.session_max_age_minutes * 60 * 1000) return null;
    }
  } catch {
    // ignore policy lookup failure
  }
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
