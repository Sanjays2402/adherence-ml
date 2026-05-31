/**
 * POST /api/security/csp-report
 *
 * Public ingest endpoint for browser CSP violations. Wired into the
 * dashboard's CSP via `report-uri` (CSP Level 2) and `report-to` (Reporting
 * API). Browsers POST untrusted JSON here whenever a script-src or
 * connect-src directive is violated, which is our XSS canary.
 *
 * No auth: the spec requires this to be reachable without credentials so
 * that any tab on the origin can deliver a report. To stay safe we:
 *
 *   - cap the body size at 8 KiB,
 *   - accept only the two well-known content types,
 *   - clip every stored string,
 *   - keep at most ~512 reports in a ring buffer,
 *   - never echo report content back to the caller.
 *
 * Returns 204 (no content) on success per the CSP spec.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ingest } from "@/lib/csp-reports-store";
import { logger, requestIdFrom } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024;

const ACCEPTED_TYPES = new Set([
  "application/csp-report",
  "application/reports+json",
  "application/json", // some browsers still send this
]);

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return null;
}

export async function POST(req: NextRequest) {
  const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ACCEPTED_TYPES.has(ct)) {
    // Don't 400 noisily, just drop.
    return new NextResponse(null, { status: 204 });
  }

  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  if (raw.length > MAX_BYTES) {
    return new NextResponse(null, { status: 413 });
  }
  if (raw.length === 0) {
    return new NextResponse(null, { status: 204 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const stored = ingest({
    source_ip: clientIp(req),
    user_agent: req.headers.get("user-agent"),
    body,
  });

  for (const row of stored) {
    logger.warn("csp.violation", {
      request_id: requestIdFrom(req),
      envelope: row.envelope,
      document_uri: row.document_uri,
      violated_directive: row.violated_directive,
      blocked_uri: row.blocked_uri,
      disposition: row.disposition,
      source_ip: row.source_ip,
    });
  }

  return new NextResponse(null, { status: 204 });
}

// Explicitly reject other verbs so scanners do not see a 405-ambiguous endpoint.
export async function GET() {
  return NextResponse.json({ detail: "POST CSP reports here" }, { status: 405 });
}
