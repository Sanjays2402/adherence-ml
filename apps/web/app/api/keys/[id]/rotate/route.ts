import { NextRequest, NextResponse } from "next/server";
import { rotateKey } from "@/lib/api-keys-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const issued = await rotateKey(id);
  if (!issued) {
    return NextResponse.json(
      { detail: "key not found, revoked, or expired" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    id: issued.record.id,
    name: issued.record.name,
    prefix: issued.record.prefix,
    rotated_at: issued.record.rotated_at,
    key: issued.plaintext, // shown exactly once
  });
}
