/**
 * GET /api/well-known/security.json
 *
 * Proxies the upstream API's public trust manifest. Lets the Trust
 * Center page link to a same-origin URL while the buyer-facing
 * download still reflects whatever the API server currently advertises.
 *
 * No auth. Edge-cached. Never returns customer data.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = process.env.ADHERENCE_API_BASE ?? "http://localhost:7421";

export async function GET() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const r = await fetch(`${API_BASE}/.well-known/security.json`, {
      cache: "no-store",
      signal: ac.signal,
    });
    clearTimeout(timer);
    const body = await r.text();
    return new NextResponse(body, {
      status: r.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
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
