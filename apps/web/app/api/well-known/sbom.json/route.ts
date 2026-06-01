/**
 * GET /api/well-known/sbom.json
 *
 * Proxies the upstream API's public CycloneDX 1.5 SBOM. Same-origin
 * link from the Trust Center so a buyer can pull the SBOM without
 * leaving the dashboard origin.
 *
 * No auth. Cached. Never returns customer data.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = process.env.ADHERENCE_API_BASE ?? "http://localhost:7421";

export async function GET() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(`${API_BASE}/.well-known/sbom.json`, {
      cache: "no-store",
      signal: ac.signal,
    });
    clearTimeout(timer);
    const body = await r.text();
    return new NextResponse(body, {
      status: r.status,
      headers: {
        "content-type": "application/vnd.cyclonedx+json",
        "cache-control": "public, max-age=300",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "upstream_unavailable" },
      { status: 502 },
    );
  }
}
