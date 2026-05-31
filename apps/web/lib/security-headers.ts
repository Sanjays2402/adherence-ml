/**
 * Enterprise security headers.
 *
 * Single source of truth for the response headers that close the
 * "OWASP secure headers" line item on every procurement security review:
 * SOC2 CC6, ISO 27001 A.13.1, PCI-DSS 6.5, NIST SP 800-53 SC-7. We set them
 * uniformly on every HTML and API response so a reviewer running an
 * automated scanner (Mozilla Observatory, securityheaders.com,
 * `nuclei -t http/misconfiguration/http-missing-security-headers`) gets a
 * clean report without us hand-rolling per-route logic.
 *
 * The CSP is tight by default and uses a per-request nonce so inline
 * Next.js bootstrap scripts still execute. Strict by default; opt looser
 * behaviour in via env vars rather than soft defaults.
 *
 * Pure module: no `next` imports here so it can be unit-tested under node
 * vitest without spinning up a runtime.
 */

export type HeaderMap = Record<string, string>;

export interface SecurityHeaderOptions {
  /** Random base64url nonce, e.g. crypto.randomUUID().replace(/-/g,"").slice(0,22). */
  nonce: string;
  /** True for routes under /api/* and /v1/* (JSON, not HTML). */
  isApi: boolean;
  /** True for the share-link viewer at /share/[token] which embeds iframes. */
  isPublicShare?: boolean;
  /**
   * Comma-separated CSP `connect-src` additions. Useful when a tenant
   * wires a custom telemetry endpoint. Defaults to `'self'` only.
   */
  extraConnectSrc?: string;
  /** Disable HSTS in local dev so http://localhost works after one https visit. */
  hsts?: boolean;
}

/**
 * Browser feature toggles. We disable powerful APIs nobody on this app
 * legitimately needs so a future XSS cannot, e.g., open the camera. If a
 * feature is added later (geofence intervention?), explicitly enable it here.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "battery=()",
  "camera=()",
  "display-capture=()",
  "document-domain=()",
  "encrypted-media=()",
  "fullscreen=(self)",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=(self)",
  "screen-wake-lock=()",
  "serial=()",
  "sync-xhr=()",
  "usb=()",
  "web-share=()",
  "xr-spatial-tracking=()",
].join(", ");

function buildCsp(opts: SecurityHeaderOptions): string {
  const { nonce, isApi, isPublicShare, extraConnectSrc } = opts;
  const connect = ["'self'"];
  if (extraConnectSrc) {
    for (const part of extraConnectSrc.split(",")) {
      const v = part.trim();
      if (v && /^[a-z0-9+.\-:/* ]+$/i.test(v)) connect.push(v);
    }
  }
  // Frame ancestors: by default we forbid embedding; public share links
  // allow framing for partner dashboards.
  const frameAncestors = isPublicShare ? "'self' *" : "'none'";

  if (isApi) {
    // For JSON endpoints, the CSP is mostly defensive belt-and-suspenders.
    return [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
  }

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Returns the full header map to apply to a response. Callers (middleware,
 * route handlers) should iterate and set each entry. Header values are
 * static strings so they are safe to log in the response audit trail.
 */
export function buildSecurityHeaders(opts: SecurityHeaderOptions): HeaderMap {
  const headers: HeaderMap = {
    "Content-Security-Policy": buildCsp(opts),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": opts.isPublicShare ? "SAMEORIGIN" : "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": opts.isPublicShare ? "cross-origin" : "same-origin",
    "X-DNS-Prefetch-Control": "off",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Origin-Agent-Cluster": "?1",
  };
  if (opts.hsts) {
    // 2-year max-age with includeSubDomains and preload meets the HSTS
    // preload list requirements.
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }
  return headers;
}

/** Generate a 22-char base64url nonce suitable for `script-src 'nonce-...'`. */
export function newNonce(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  } catch {
    return Math.random().toString(36).slice(2, 14) + Date.now().toString(36).slice(0, 10);
  }
}

/** True when the path should receive the API-flavored CSP. */
export function isApiPath(path: string): boolean {
  return (
    path.startsWith("/api/") ||
    path === "/api" ||
    path.startsWith("/v1/") ||
    path === "/v1" ||
    path.startsWith("/scim/")
  );
}

/** True when the path is the public share viewer. */
export function isPublicSharePath(path: string): boolean {
  return path === "/share" || path.startsWith("/share/");
}

/** True when HSTS should be advertised. Off in dev so localhost http keeps working. */
export function shouldEnableHsts(env: Record<string, string | undefined>): boolean {
  if (env.ADHERENCE_DISABLE_HSTS === "1") return false;
  // Default ON in production; OFF locally.
  return env.NODE_ENV === "production";
}
