import { NextRequest, NextResponse } from "next/server";
import { apiFetch, ApiError } from "@/lib/api";

/**
 * Helper for server-side GET proxies that map a Next route to one
 * upstream FastAPI path, preserving the querystring.
 */
export function proxyGet(upstreamPath: string) {
  return async (req: NextRequest) => {
    const qs = req.nextUrl.searchParams.toString();
    try {
      const data = await apiFetch(`${upstreamPath}${qs ? `?${qs}` : ""}`);
      return NextResponse.json(data);
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json(
          typeof err.body === "object" && err.body ? err.body : { detail: err.message },
          { status: err.status },
        );
      }
      return NextResponse.json({ detail: String(err) }, { status: 502 });
    }
  };
}

export function proxyPost(upstreamPath: string) {
  return async (req: NextRequest) => {
    const qs = req.nextUrl.searchParams.toString();
    const body = await req.text();
    try {
      const data = await apiFetch(`${upstreamPath}${qs ? `?${qs}` : ""}`, {
        method: "POST",
        body: body && body.length > 0 ? body : undefined,
        headers: body && body.length > 0 ? { "content-type": "application/json" } : undefined,
      });
      return NextResponse.json(data);
    } catch (err) {
      if (err instanceof ApiError) {
        return NextResponse.json(
          typeof err.body === "object" && err.body ? err.body : { detail: err.message },
          { status: err.status },
        );
      }
      return NextResponse.json({ detail: String(err) }, { status: 502 });
    }
  };
}
