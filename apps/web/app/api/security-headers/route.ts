/**
 * GET /api/security-headers
 *
 * Returns the exact set of HTTP security headers the dashboard will attach
 * to a response for a given path. Intended for the in-app SOC2 review
 * page (`/settings/security-headers`) and for ops scripts that want to
 * verify configuration without an external scanner.
 *
 * Authenticated: requires a signed-in user. Read-only and idempotent.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  buildSecurityHeaders,
  isApiPath,
  isPublicSharePath,
  newNonce,
  resolveCspReportUri,
  shouldEnableHsts,
} from "@/lib/security-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path") ?? "/";
  // Defensive: only accept paths that look like a URL path, no schemes.
  const path = /^\/[A-Za-z0-9_\-./[\]]*$/.test(rawPath) ? rawPath : "/";

  const nonce = newNonce();
  const headers = buildSecurityHeaders({
    nonce,
    isApi: isApiPath(path),
    isPublicShare: isPublicSharePath(path),
    extraConnectSrc: process.env.ADHERENCE_CSP_CONNECT_SRC,
    hsts: shouldEnableHsts(process.env as Record<string, string | undefined>),
    cspReportUri: resolveCspReportUri(process.env as Record<string, string | undefined>),
  });

  return NextResponse.json({
    path,
    nonce_sample: nonce,
    hsts_enabled: shouldEnableHsts(process.env as Record<string, string | undefined>),
    headers,
    // Lightweight scorecard so the operator can paste it into a procurement
    // questionnaire without running an external scanner.
    checks: [
      { id: "csp", label: "Content Security Policy", ok: "Content-Security-Policy" in headers },
      { id: "hsts", label: "Strict Transport Security", ok: "Strict-Transport-Security" in headers },
      { id: "xfo", label: "Clickjacking protection", ok: "X-Frame-Options" in headers },
      { id: "xcto", label: "MIME sniffing disabled", ok: headers["X-Content-Type-Options"] === "nosniff" },
      { id: "ref", label: "Referrer policy", ok: "Referrer-Policy" in headers },
      { id: "perm", label: "Permissions policy", ok: "Permissions-Policy" in headers },
      { id: "coop", label: "Cross-origin opener policy", ok: "Cross-Origin-Opener-Policy" in headers },
      { id: "corp", label: "Cross-origin resource policy", ok: "Cross-Origin-Resource-Policy" in headers },
      { id: "csp-report", label: "CSP violation reporting", ok: "Reporting-Endpoints" in headers || "Report-To" in headers },
    ],
  });
}
