/**
 * POST /api/workspaces/:id/transfer-ownership
 *
 * Owner-only. Hands the `owner` role to an existing member and demotes the
 * caller to `editor` (default) or `viewer`. This is the missing piece the
 * account-erasure flow already tells users to do ("transfer ownership before
 * deleting your account"): without it a sole owner is stranded.
 *
 * Supports `?dry_run=true` and writes a tamper-evident audit row on every
 * outcome (success or denied).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  getWorkspaceForUser,
  transferOwnership,
} from "@/lib/workspaces-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { recordAudit } from "@/lib/dashboard-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  target_user_id: z.string().min(1),
  demote_to: z.enum(["editor", "viewer"]).optional().default("editor"),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx)
    return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws)
    return NextResponse.json({ detail: "not found" }, { status: 404 });

  if (ws.role !== "owner") {
    await recordAudit({
      action: "workspace.ownership.transfer",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: "not_owner", caller_role: ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { target_user_id: targetId, demote_to: demoteTo } = parsed.data;

  const target = ws.members.find((m) => m.user_id === targetId);
  if (!target)
    return NextResponse.json({ detail: "member not found" }, { status: 404 });
  if (targetId === ctx.user.id)
    return NextResponse.json(
      { detail: "cannot transfer ownership to yourself" },
      { status: 400 },
    );

  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_ownership",
          id: `${id}:${targetId}`,
          summary:
            `transfer ownership of '${ws.workspace.name}' to ${target.email ?? targetId}; ` +
            `you (${ctx.user.email ?? ctx.user.id}) become ${demoteTo}`,
          before: {
            owner: { user_id: ctx.user.id, email: ctx.user.email ?? null, role: "owner" },
            target: {
              user_id: target.user_id,
              email: target.email,
              role: target.role,
            },
          },
        }),
      ),
    );
  }

  const result = await transferOwnership(id, ctx.user.id, targetId, demoteTo);
  if (typeof result === "string") {
    const status =
      result === "forbidden"
        ? 403
        : result === "not_found"
          ? 404
          : 400;
    await recordAudit({
      action: "workspace.ownership.transfer",
      target: `${id}:${targetId}`,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: {
        workspace_id: id,
        target_user_id: targetId,
        target_email: target.email ?? null,
        demote_to: demoteTo,
        reason: result,
      },
    });
    return NextResponse.json({ detail: result }, { status });
  }

  await recordAudit({
    action: "workspace.ownership.transfer",
    target: `${id}:${targetId}`,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: {
      workspace_id: id,
      workspace_name: ws.workspace.name,
      new_owner_user_id: targetId,
      new_owner_email: target.email ?? null,
      previous_owner_user_id: ctx.user.id,
      previous_owner_email: ctx.user.email ?? null,
      previous_owner_demoted_to: demoteTo,
    },
  });
  return NextResponse.json({
    ok: true,
    new_owner: result.target,
    previous_owner: result.acting,
  });
}
