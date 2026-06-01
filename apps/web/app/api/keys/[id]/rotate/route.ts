import { NextRequest, NextResponse } from "next/server";
import { rotateKey } from "@/lib/api-keys-store";
import { requireDashboardAuth, auditAction } from "@/lib/dashboard-auth";
import { effectiveApiKeyMaxTtlDays } from "@/lib/workspaces-store";
import { emit } from "@/lib/webhook-dispatch";

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
    stepUp: true,
  });
  if (!gate.ok) return gate.response;

  const cap = await effectiveApiKeyMaxTtlDays();
  const issued = await rotateKey(id, { capTtlDays: cap });
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
  void emit("api_key.rotated", {
    key_id: issued.record.id,
    key_name: issued.record.name,
    new_prefix: issued.record.prefix,
    rotated_by:
      gate.ctx.session?.user.email ?? gate.ctx.session?.user.id ?? "system",
    rotated_at: new Date(issued.record.rotated_at ?? Date.now()).toISOString(),
  });
  return NextResponse.json({
    id: issued.record.id,
    name: issued.record.name,
    prefix: issued.record.prefix,
    rotated_at: issued.record.rotated_at,
    key: issued.plaintext, // shown exactly once
  });
}
