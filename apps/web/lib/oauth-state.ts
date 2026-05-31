/**
 * OAuth state helpers (CSRF + return URL).
 *
 * The state value is an HMAC-signed, base64url-encoded JSON payload stored
 * in a short-lived HttpOnly cookie. On the callback we verify the cookie
 * matches the query-string state. No external store required.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_STATE_COOKIE = "adh_oauth_state";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface StatePayload {
  n: string;       // nonce
  nx: string;      // next (safe relative path)
  iat: number;
  exp: number;
  p: string;       // provider id (e.g. "github")
}

function getSecret(): Buffer {
  const fromEnv = process.env.ADHERENCE_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, "utf8");
  return createHash("sha256")
    .update("adherence-ml-dev-fallback:" + process.cwd())
    .digest();
}

function b64u(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b.toString("base64url");
}

function b64uDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function buildOAuthState(provider: string, next: string | null): string {
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const payload: StatePayload = {
    n: randomBytes(12).toString("base64url"),
    nx: safeNext,
    iat: Date.now(),
    exp: Date.now() + OAUTH_STATE_TTL_MS,
    p: provider,
  };
  const body = b64u(JSON.stringify(payload));
  const mac = createHmac("sha256", getSecret()).update(body).digest();
  return body + "." + b64u(mac);
}

export function verifyOAuthState(raw: string | undefined, provider: string): StatePayload | null {
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
  let payload: StatePayload;
  try {
    payload = JSON.parse(b64uDecode(body).toString("utf8")) as StatePayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  if (payload.p !== provider) return null;
  if (typeof payload.nx !== "string" || !payload.nx.startsWith("/") || payload.nx.startsWith("//")) {
    payload.nx = "/";
  }
  return payload;
}

export function isGithubOAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}
