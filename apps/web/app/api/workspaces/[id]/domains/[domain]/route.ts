import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  getWorkspaceForUser,
  publicVerifiedDomain,
  setDomainAutoJoin,
  unclaimDomain,
  verifyDomain,
} from "@/lib/workspaces-store";
import { recordAudit } from "@/lib/dashboard-audit";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  action: z.enum(["verify", "update"]),
  presented_token: z.string().optional(),
  auto_join: z.boolean().optional(),
  default_role: z.enum(["editor", "viewer"]).optional(),
});

async function requireOwner(workspaceId: string, userId: string) {
  const ws = await getWorkspaceForUser(workspaceId, userId);
  if (!ws) return { error: "not_found" as const };
  if (ws.role !== "owner") return { error: "forbidden" as const, ws };
  return { ws };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; domain: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id, domain } = await params;
  const d = decodeURIComponent(domain).toLowerCase();
  const guard = await requireOwner(id, ctx.user.id);
  if (guard.error === "not_found") return NextResponse.json({ detail: "not found" }, { status: 404 });
  if (guard.error === "forbidden") {
    await recordAudit({
      action: "workspace.domain.update",
      target: `${id}:${d}`,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: "not_owner", caller_role: guard.ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if (isDryRun(req)) {
    const verb = parsed.data.action === "verify"
      ? `verify ownership of ${d}; auto-join becomes available after this succeeds`
      : `update ${d}: auto_join=${parsed.data.auto_join ?? "unchanged"} default_role=${parsed.data.default_role ?? "unchanged"}`;
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_domain",
          id: `${id}:${d}`,
          summary: verb,
        }),
      ),
    );
  }

  const action = parsed.data.action;
  const result = action === "verify"
    ? await verifyDomain(id, ctx.user.id, d, parsed.data.presented_token)
    : await setDomainAutoJoin(id, ctx.user.id, d, {
        auto_join: parsed.data.auto_join,
        default_role: parsed.data.default_role,
      });
  if (typeof result === "string") {
    const status =
      result === "forbidden" ? 403 :
      result === "not_found" ? 404 :
      result === "already_verified_elsewhere" ? 409 :
      result === "txt_not_found" || result === "token_mismatch_dns" || result === "dns_lookup_failed" ? 422 :
      400;
    await recordAudit({
      action: `workspace.domain.${action}`,
      target: `${id}:${d}`,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: result, domain: d },
    });
    return NextResponse.json({ detail: result }, { status });
  }
  await recordAudit({
    action: `workspace.domain.${action}`,
    target: `${id}:${d}`,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: {
      workspace_id: id,
      domain: d,
      status: result.status,
      auto_join: result.auto_join,
      default_role: result.default_role,
    },
  });
  return NextResponse.json({ ok: true, domain: publicVerifiedDomain(result) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; domain: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id, domain } = await params;
  const d = decodeURIComponent(domain).toLowerCase();
  const guard = await requireOwner(id, ctx.user.id);
  if (guard.error === "not_found") return NextResponse.json({ detail: "not found" }, { status: 404 });
  if (guard.error === "forbidden") {
    await recordAudit({
      action: "workspace.domain.unclaim",
      target: `${id}:${d}`,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: "not_owner", caller_role: guard.ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_domain",
          id: `${id}:${d}`,
          summary: `unclaim domain ${d} from workspace; existing members keep access, but new sign-ins from this domain will no longer auto-join`,
        }),
      ),
    );
  }
  const r = await unclaimDomain(id, ctx.user.id, d);
  if (typeof r === "string") {
    const status = r === "forbidden" ? 403 : r === "not_found" ? 404 : 400;
    await recordAudit({
      action: "workspace.domain.unclaim",
      target: `${id}:${d}`,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: r, domain: d },
    });
    return NextResponse.json({ detail: r }, { status });
  }
  await recordAudit({
    action: "workspace.domain.unclaim",
    target: `${id}:${d}`,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: { workspace_id: id, domain: d },
  });
  return NextResponse.json({ ok: true });
}
