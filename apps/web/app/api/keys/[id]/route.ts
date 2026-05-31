import { NextRequest, NextResponse } from "next/server";
import { revokeKey } from "@/lib/api-keys-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = await revokeKey(id);
  if (!ok) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
