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

const HEADER = "x-request-id";

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

  const reqHeaders = new Headers(req.headers);
  reqHeaders.set(HEADER, rid);
  reqHeaders.set("x-request-started-at", String(t0));

  const res = NextResponse.next({ request: { headers: reqHeaders } });
  res.headers.set(HEADER, rid);

  // Structured access log. Skip Next internals + static assets to avoid noise.
  const path = req.nextUrl.pathname;
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
