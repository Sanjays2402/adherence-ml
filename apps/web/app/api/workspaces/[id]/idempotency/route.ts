/**
 * Owner-only console for the Idempotency-Key cache scoped to this workspace.
 *
 *   GET    -> list cached keys (newest first), no body payloads
 *   DELETE -> clear all cached keys for the workspace (audit recorded)
 *
 * Tenant scoping is enforced at the store layer: every read/write is keyed
 * by `workspaceId`, so two workspaces can use the same `Idempotency-Key`
 * value without colliding and an owner of workspace A can never see or
 * purge entries belonging to workspace B.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getWorkspaceForUser } from "@/lib/workspaces-store";
import { clearWorkspace, listRecords } from "@/lib/idempotency-store";
import { recordAudit } from "@/lib/dashboard-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  if (ws.role !== "owner") {
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  const records = await listRecords(id);
  return NextResponse.json({
    ttl_hours: 24,
    items: records.map((r) => ({
      key: r.key,
      request_hash: r.request_hash,
      status: r.status,
      created_at: r.created_at,
      expires_at: r.expires_at,
      bytes: Buffer.byteLength(r.body, "utf8"),
    })),
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  if (ws.role !== "owner") {
    await recordAudit({
      action: "workspace.idempotency.clear",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: "not_owner", caller_role: ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  const removed = await clearWorkspace(id);
  await recordAudit({
    action: "workspace.idempotency.clear",
    target: id,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: { removed },
  });
  return NextResponse.json({ ok: true, removed });
}
