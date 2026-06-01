/**
 * GET /api/well-known/security.txt
 *
 * Proxies the upstream API's RFC 9116 security.txt so the Trust Center
 * download buttons stay same-origin and CORS-free.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_BASE = process.env.ADHERENCE_API_BASE ?? "http://localhost:7421";

export async function GET() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const r = await fetch(`${API_BASE}/.well-known/security.txt`, {
      cache: "no-store",
      signal: ac.signal,
    });
    clearTimeout(timer);
    const body = await r.text();
    return new NextResponse(body, {
      status: r.status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  } catch {
    return new NextResponse("upstream_unavailable", { status: 502 });
  }
}
