import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  changeMemberRoleByOwner,
  getWorkspaceForUser,
  listInvites,
  publicSso,
  removeMember,
  ROLES,
} from "@/lib/workspaces-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { recordAudit } from "@/lib/dashboard-audit";
import { withResidencyHeaders } from "@/lib/residency";
import { publicPolicy } from "@/lib/workspaces-store";

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
  const invites = await listInvites(id);
  return withResidencyHeaders(
    NextResponse.json({
      workspace: ws.workspace,
      role: ws.role,
      members: ws.members,
      sso: publicSso(ws.workspace.sso),
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        created_at: i.created_at,
        expires_at: i.expires_at,
        accepted_at: i.accepted_at,
        revoked_at: i.revoked_at,
      })),
    }),
    publicPolicy(ws.workspace.security_policy).data_residency,
  );
}

const PatchSchema = z.object({
  user_id: z.string().min(1),
  role: z.enum(ROLES as [string, ...string[]]),
});

export async function PATCH(
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
      action: "workspace.member.role_change",
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
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { user_id: targetId, role: nextRole } = parsed.data;
  const member = ws.members.find((m) => m.user_id === targetId);
  if (!member) return NextResponse.json({ detail: "member not found" }, { status: 404 });

  if (isDryRun(req)) {
    if (member.role === nextRole) {
      return withDryRunHeaders(
        NextResponse.json(
          dryRunBody({
            resource: "workspace_member",
            id: `${id}:${targetId}`,
            summary: `no-op: ${member.email ?? targetId} already has role ${nextRole}`,
            before: member as unknown as Record<string, unknown>,
          }),
        ),
      );
    }
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_member",
          id: `${id}:${targetId}`,
          summary: `change role of ${member.email ?? targetId} from ${member.role} to ${nextRole} in workspace '${ws.workspace.name}'`,
          before: member as unknown as Record<string, unknown>,
        }),
      ),
    );
  }

  const result = await changeMemberRoleByOwner(
    id,
    ctx.user.id,
    targetId,
    nextRole as "owner" | "editor" | "viewer",
  );
  if (typeof result === "string") {
    const status = result === "forbidden" ? 403 : result === "not_found" ? 404 : 400;
    await recordAudit({
      action: "workspace.member.role_change",
      target: `${id}:${targetId}`,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: {
        workspace_id: id,
        target_user_id: targetId,
        target_email: member.email ?? null,
        from_role: member.role,
        to_role: nextRole,
        reason: result,
      },
    });
    return NextResponse.json({ detail: result }, { status });
  }
  await recordAudit({
    action: "workspace.member.role_change",
    target: `${id}:${targetId}`,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: {
      workspace_id: id,
      target_user_id: targetId,
      target_email: member.email ?? null,
      from_role: member.role,
      to_role: nextRole,
    },
  });
  return NextResponse.json({ ok: true, member: result });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const url = new URL(req.url);
  const target = url.searchParams.get("user_id");
  if (!target) return NextResponse.json({ detail: "user_id required" }, { status: 400 });

  if (isDryRun(req)) {
    const ws = await getWorkspaceForUser(id, ctx.user.id);
    if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
    if (ws.role !== "owner") {
      return NextResponse.json({ detail: "owner only" }, { status: 403 });
    }
    const member = ws.members.find((m) => m.user_id === target);
    if (!member) return NextResponse.json({ detail: "member not found" }, { status: 404 });
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_member",
          id: `${id}:${target}`,
          summary: `remove member ${member.email ?? target} (role ${member.role}) from workspace '${ws.workspace.name}'; they lose access immediately`,
          before: member as unknown as Record<string, unknown>,
        }),
      ),
    );
  }

  const ws = await getWorkspaceForUser(id, ctx.user.id);
  const beforeMember = ws?.members.find((m) => m.user_id === target) ?? null;
  const ok = await removeMember(id, ctx.user.id, target);
  if (!ok) {
    await recordAudit({
      action: "workspace.member.remove",
      target: `${id}:${target}`,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: {
        workspace_id: id,
        target_user_id: target,
        reason: ws && ws.role !== "owner" ? "not_owner" : "not_found_or_last_owner",
      },
    });
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }
  await recordAudit({
    action: "workspace.member.remove",
    target: `${id}:${target}`,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: {
      workspace_id: id,
      target_user_id: target,
      target_email: beforeMember?.email ?? null,
      previous_role: beforeMember?.role ?? null,
    },
  });
  return NextResponse.json({ ok: true });
}
