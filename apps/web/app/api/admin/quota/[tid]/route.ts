import { NextRequest, NextResponse } from "next/server";
import { apiFetch, ApiError } from "@/lib/api";

async function forward(path: string, init: RequestInit) {
  try {
    const data = await apiFetch(path, init);
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
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ tid: string }> }) {
  const { tid } = await ctx.params;
  return forward(`/v1/admin/quota/${encodeURIComponent(tid)}`, { method: "GET" });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ tid: string }> }) {
  const { tid } = await ctx.params;
  const body = await req.text();
  return forward(`/v1/admin/quota/${encodeURIComponent(tid)}`, {
    method: "PUT",
    body: body && body.length > 0 ? body : "{}",
    headers: { "content-type": "application/json" },
  });
}
