/**
 * Minimal OIDC client for per-workspace SSO. Zero external deps.
 *
 * We implement just enough of OIDC to support Google Workspace, Okta, and
 * Azure AD: discovery via /.well-known/openid-configuration, authorization
 * code flow with state + PKCE, code -> id_token exchange, and id_token
 * signature verification via the issuer's JWKS (RS256 / ES256).
 *
 * id_token signature verification is the security gate: we trust whatever
 * email the IdP signs into the token. We do NOT call userinfo because the
 * id_token already carries email + email_verified for the providers we
 * care about and one less round-trip is one less failure mode.
 */
import { createHash, createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
}

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

interface DiscoveryEntry {
  fetched_at: number;
  doc: DiscoveryDoc;
}

interface JwksEntry {
  fetched_at: number;
  keys: Jwk[];
}

const discoveryCache = new Map<string, DiscoveryEntry>();
const jwksCache = new Map<string, JwksEntry>();

function b64u(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b.toString("base64url");
}

function b64uDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export async function discover(issuer: string): Promise<DiscoveryDoc> {
  const key = issuer.replace(/\/+$/, "");
  const cached = discoveryCache.get(key);
  if (cached && Date.now() - cached.fetched_at < DISCOVERY_TTL_MS) return cached.doc;
  const url = key + "/.well-known/openid-configuration";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`oidc discovery failed (${res.status})`);
  const doc = (await res.json()) as DiscoveryDoc;
  if (!doc || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("oidc discovery document is missing required fields");
  }
  discoveryCache.set(key, { fetched_at: Date.now(), doc });
  return doc;
}

async function fetchJwks(jwksUri: string, force = false): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (!force && cached && Date.now() - cached.fetched_at < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(jwksUri, { cache: "no-store" });
  if (!res.ok) throw new Error(`jwks fetch failed (${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(jwksUri, { fetched_at: Date.now(), keys });
  return keys;
}

function jwkToPem(jwk: Jwk): string {
  // Node's createPublicKey accepts JWK directly since 16.x.
  const key = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
  return key.export({ type: "spki", format: "pem" }) as string;
}

const SUPPORTED_ALGS: Record<string, { node: string; type: "rsa" | "ec" }> = {
  RS256: { node: "RSA-SHA256", type: "rsa" },
  RS384: { node: "RSA-SHA384", type: "rsa" },
  RS512: { node: "RSA-SHA512", type: "rsa" },
  ES256: { node: "sha256", type: "ec" },
  ES384: { node: "sha384", type: "ec" },
};

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string; // Google Workspace domain hint
  preferred_username?: string;
  [k: string]: unknown;
}

/**
 * Verify an OIDC id_token against the issuer's JWKS. Validates signature,
 * iss, aud, exp, and nonce. Returns the parsed claims when valid.
 */
export async function verifyIdToken(
  idToken: string,
  opts: { issuer: string; client_id: string; nonce: string; clockSkewSec?: number },
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token must have three segments");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(b64uDecode(headerB64).toString("utf8")) as { alg: string; kid?: string; typ?: string };
  const claims = JSON.parse(b64uDecode(payloadB64).toString("utf8")) as IdTokenClaims;
  const alg = SUPPORTED_ALGS[header.alg];
  if (!alg) throw new Error(`unsupported id_token alg: ${header.alg}`);

  const doc = await discover(opts.issuer);
  // Issuer in the token must match exactly (per spec).
  if (claims.iss !== doc.issuer && claims.iss !== opts.issuer.replace(/\/+$/, "")) {
    throw new Error(`id_token issuer mismatch (got ${claims.iss})`);
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.client_id)) throw new Error("id_token aud mismatch");
  const skew = opts.clockSkewSec ?? 60;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + skew < now) {
    throw new Error("id_token expired");
  }
  if (typeof claims.iat === "number" && claims.iat - skew > now) {
    throw new Error("id_token issued in the future");
  }
  if (typeof opts.nonce === "string" && opts.nonce && claims.nonce !== opts.nonce) {
    throw new Error("id_token nonce mismatch");
  }

  // Find a JWK matching kid (or any key if no kid).
  let keys = await fetchJwks(doc.jwks_uri);
  let jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg));
  if (!jwk) {
    // Refresh JWKS once to handle key rotation.
    keys = await fetchJwks(doc.jwks_uri, true);
    jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg));
  }
  if (!jwk) throw new Error("id_token signing key not found in JWKS");

  const pem = jwkToPem(jwk);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const sig = b64uDecode(sigB64);
  if (alg.type === "rsa") {
    const v = createVerify(alg.node);
    v.update(signingInput);
    v.end();
    if (!v.verify(pem, sig)) throw new Error("id_token signature invalid");
  } else {
    // ES256/ES384: signature is r||s (IEEE P1363). Node expects DER.
    const der = p1363ToDer(sig);
    const v = createVerify(alg.node);
    v.update(signingInput);
    v.end();
    if (!v.verify({ key: pem, dsaEncoding: "der" } as never, der)) {
      throw new Error("id_token signature invalid");
    }
  }
  return claims;
}

function p1363ToDer(sig: Buffer): Buffer {
  const half = sig.length / 2;
  const r = stripLeadingZeros(sig.subarray(0, half));
  const s = stripLeadingZeros(sig.subarray(half));
  const rEnc = encodeInteger(r);
  const sEnc = encodeInteger(s);
  const seqLen = rEnc.length + sEnc.length;
  return Buffer.concat([Buffer.from([0x30, seqLen]), rEnc, sEnc]);
}

function stripLeadingZeros(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

function encodeInteger(b: Buffer): Buffer {
  // High bit set => prepend 0x00 so the integer stays positive in DER.
  const needsPad = (b[0] & 0x80) !== 0;
  const body = needsPad ? Buffer.concat([Buffer.from([0x00]), b]) : b;
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

// --- State + PKCE -------------------------------------------------------

export interface SsoStatePayload {
  n: string;       // nonce
  nx: string;      // next path
  ws: string;      // workspace id
  cv: string;      // PKCE code_verifier
  non: string;     // OIDC nonce
  iat: number;
  exp: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function ssoSecret(): Buffer {
  const fromEnv = process.env.ADHERENCE_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, "utf8");
  return createHash("sha256")
    .update("adherence-ml-dev-fallback:" + process.cwd())
    .digest();
}

export function buildSsoState(workspaceId: string, next: string | null): { value: string; payload: SsoStatePayload } {
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const payload: SsoStatePayload = {
    n: randomBytes(12).toString("base64url"),
    nx: safeNext,
    ws: workspaceId,
    cv: randomBytes(32).toString("base64url"),
    non: randomBytes(16).toString("base64url"),
    iat: Date.now(),
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = b64u(JSON.stringify(payload));
  const mac = createHmac("sha256", ssoSecret()).update(body).digest();
  return { value: body + "." + b64u(mac), payload };
}

export function verifySsoState(raw: string | undefined): SsoStatePayload | null {
  if (!raw || typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", ssoSecret()).update(body).digest();
  let actual: Buffer;
  try {
    actual = b64uDecode(sig);
  } catch {
    return null;
  }
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  let payload: SsoStatePayload;
  try {
    payload = JSON.parse(b64uDecode(body).toString("utf8")) as SsoStatePayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  return payload;
}

export function pkceChallenge(verifier: string): string {
  return b64u(createHash("sha256").update(verifier).digest());
}

// --- Cache control for tests --------------------------------------------

export const SSO_STATE_COOKIE = "adh_sso_state";

export function _resetOidcCachesForTests(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
