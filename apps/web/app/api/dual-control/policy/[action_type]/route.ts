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

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ action_type: string }> },
) {
  const { action_type } = await ctx.params;
  try {
    await apiFetch(
      `/v1/admin/dual-control/policy/${encodeURIComponent(action_type)}`,
      { method: "DELETE" },
    );
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return bubble(err);
  }
}
