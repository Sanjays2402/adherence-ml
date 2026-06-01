import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bubble(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      typeof err.body === "object" && err.body !== null ? err.body : { detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { detail: err instanceof Error ? err.message : "upstream error" },
    { status: 502 },
  );
}

function fwd(req: NextRequest): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" };
  const rid = req.headers.get("x-request-id");
  if (rid) h["x-request-id"] = rid;
  return h;
}

export async function GET(req: NextRequest) {
  try {
    const data = await apiFetch(`/v1/subprocessors/outstanding`, {
      headers: fwd(req),
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
