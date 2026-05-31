/**
 * GET /api/security/csp-reports
 *
 * Authenticated read of the in-process CSP violation buffer. Drives the
 * panel on /settings/security-headers so operators can confirm reports
 * are flowing during an incident and triage spikes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { count, list } from "@/lib/csp-reports-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  let limit = 50;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (Number.isFinite(n) && n > 0 && n <= 500) limit = Math.floor(n);
  }
  return NextResponse.json({
    total: count(),
    limit,
    reports: list(limit),
  });
}
