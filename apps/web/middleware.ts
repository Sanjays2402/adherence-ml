/**
 * Root middleware: enterprise observability.
 *
 * - Stamps every request with a stable `x-request-id` (preserves caller's
 *   if present so distributed traces stitch across the load balancer,
 *   the dashboard, and the FastAPI service).
 * - Emits one structured JSON access log per request to stdout. Log
 *   shippers (Datadog, Loki, CloudWatch) ingest this without a parser.
 * - Exposes the request id on the response (`x-request-id`) so support
 *   can correlate a user-reported error with a single log line.
 *
 * Runs on the Edge runtime. Keep this file dependency-free.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  buildSecurityHeaders,
  resolveCspReportUri,
  isApiPath,
  isPublicSharePath,
  newNonce,
  shouldEnableHsts,
} from "@/lib/security-headers";

const HEADER = "x-request-id";
const NONCE_HEADER = "x-csp-nonce";

function newId(): string {
  // crypto.randomUUID is available on Edge.
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  } catch {
    return Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
  }
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "0.0.0.0";
}

export function middleware(req: NextRequest) {
  const t0 = Date.now();
  const incoming = req.headers.get(HEADER);
  const rid = incoming && /^[A-Za-z0-9_-]{6,128}$/.test(incoming) ? incoming : newId();

  const nonce = newNonce();
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set(HEADER, rid);
  reqHeaders.set("x-request-started-at", String(t0));
  // Server components can read this header to thread the nonce into
  // <script nonce=...> tags when we need inline bootstrap.
  reqHeaders.set(NONCE_HEADER, nonce);

  const res = NextResponse.next({ request: { headers: reqHeaders } });
  res.headers.set(HEADER, rid);

  // Stamp enterprise security headers on every response. One source of
  // truth in lib/security-headers.ts; tested in tests/security-headers.test.ts;
  // surfaced in /settings/security-headers for the SOC2 reviewer.
  const path = req.nextUrl.pathname;
  const headers = buildSecurityHeaders({
    nonce,
    isApi: isApiPath(path),
    isPublicShare: isPublicSharePath(path),
    extraConnectSrc: process.env.ADHERENCE_CSP_CONNECT_SRC,
    hsts: shouldEnableHsts(process.env as Record<string, string | undefined>),
    cspReportUri: resolveCspReportUri(process.env as Record<string, string | undefined>),
  });
  for (const [k, v] of Object.entries(headers)) {
    res.headers.set(k, v);
  }

  // Structured access log. Skip Next internals + static assets to avoid noise.
  if (!path.startsWith("/_next") && !path.startsWith("/favicon")) {
    const line = {
      ts: new Date(t0).toISOString(),
      level: "info",
      msg: "request_start",
      request_id: rid,
      method: req.method,
      path,
      ip: clientIp(req),
      ua: req.headers.get("user-agent") ?? null,
      referer: req.headers.get("referer") ?? null,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  }

  return res;
}

export const config = {
  // Run on every route except Next internals, static files, and the bare
  // metrics/health endpoints (those are noisy and probed every few seconds).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|healthz|readyz|metrics|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)).*)",
  ],
};
