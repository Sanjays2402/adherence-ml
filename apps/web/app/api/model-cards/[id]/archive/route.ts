import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bubble(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      typeof err.body === "object" && err.body !== null
        ? err.body
        : { detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { detail: err instanceof Error ? err.message : "upstream error" },
    { status: 502 },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    return NextResponse.json({ detail: "invalid id" }, { status: 400 });
  }
  let reason: string | null = null;
  try {
    const body = await req.json();
    if (body && typeof body.reason === "string") {
      reason = body.reason.slice(0, 256);
    }
  } catch {
    // empty body is fine
  }
  try {
    const data = await apiFetch(`/v1/admin/model-cards/${n}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
