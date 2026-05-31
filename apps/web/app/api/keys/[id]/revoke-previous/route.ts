import { NextRequest, NextResponse } from "next/server";
import { publicView, revokePreviousSecret } from "@/lib/api-keys-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Immediately end an in-flight grace window so the previous secret stops
 * working right now. Returns 404 if the key is missing or has no active
 * grace to revoke (idempotent-friendly for the UI).
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const updated = await revokePreviousSecret(id);
  if (!updated) {
    return NextResponse.json(
      { detail: "no active grace window" },
      { status: 404 },
    );
  }
  return NextResponse.json(publicView(updated));
}
