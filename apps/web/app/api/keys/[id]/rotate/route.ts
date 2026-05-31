import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MAX_GRACE_MINUTES, rotateKey } from "@/lib/api-keys-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  /**
   * Keep the previous secret valid for this many minutes so callers can roll
   * out the new key with zero downtime. 0 (the default) is a hard cutover.
   */
  grace_minutes: z.number().int().min(0).max(MAX_GRACE_MINUTES).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let grace = 0;
  // Body is optional; old callers POST with no payload and get a hard cutover.
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ detail: "invalid json" }, { status: 400 });
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { detail: "invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    grace = parsed.data.grace_minutes ?? 0;
  }
  const issued = await rotateKey(id, grace);
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
    previous_prefix: issued.record.previous_prefix ?? null,
    previous_expires_at: issued.record.previous_expires_at ?? null,
    grace_minutes: grace,
    key: issued.plaintext, // shown exactly once
  });
}
