import { NextRequest, NextResponse } from "next/server";
import { rotateKey } from "@/lib/api-keys-store";
import { requireDashboardAuth, auditAction } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const gate = await requireDashboardAuth(req, {
    action: "api_key.rotate.dashboard",
    target: id,
  });
  if (!gate.ok) return gate.response;

  const issued = await rotateKey(id);
  if (!issued) {
    await auditAction(req, gate.ctx, {
      action: "api_key.rotate.dashboard",
      target: id,
      outcome: "failure",
      metadata: { reason: "not_found_or_revoked_or_expired" },
    });
    return NextResponse.json(
      { detail: "key not found, revoked, or expired" },
      { status: 404 },
    );
  }
  await auditAction(req, gate.ctx, {
    action: "api_key.rotate.dashboard",
    target: id,
    outcome: "success",
    metadata: {
      key_name: issued.record.name,
      new_prefix: issued.record.prefix,
    },
  });
  return NextResponse.json({
    id: issued.record.id,
    name: issued.record.name,
    prefix: issued.record.prefix,
    rotated_at: issued.record.rotated_at,
    key: issued.plaintext, // shown exactly once
  });
}
