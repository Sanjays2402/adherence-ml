/**
 * SCIM bearer-token management for a workspace. Owner-only.
 *
 *   GET    /api/workspaces/{id}/scim-tokens         -> list tokens (metadata only)
 *   POST   /api/workspaces/{id}/scim-tokens         -> mint new token (plaintext returned once)
 *   DELETE /api/workspaces/{id}/scim-tokens?token=  -> revoke
 *
 * Owner check + audit log + dry-run support, matching the other workspace
 * admin routes in this app.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { getWorkspaceForUser } from "@/lib/workspaces-store";
import {
  createToken,
  listForWorkspace,
  revokeToken,
} from "@/lib/scim-store";
import { recordAudit } from "@/lib/dashboard-audit";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireOwner(req: NextRequest, workspaceId: string) {
  const ctx = await getSession();
  if (!ctx) {
    return { error: NextResponse.json({ detail: "auth required" }, { status: 401 }) };
  }
  const ws = await getWorkspaceForUser(workspaceId, ctx.user.id);
  if (!ws) {
    return { error: NextResponse.json({ detail: "not found" }, { status: 404 }) };
  }
  if (ws.role !== "owner") {
    await recordAudit({
      action: "scim.token.manage",
      target: workspaceId,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email },
      request: req,
      metadata: { reason: "not_owner", role: ws.role },
    });
    return { error: NextResponse.json({ detail: "owner only" }, { status: 403 }) };
  }
  return { ctx, ws };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await requireOwner(req, id);
  if ("error" in r) return r.error;
  const items = await listForWorkspace(id);
  return NextResponse.json({ items });
}

const CreateBody = z.object({ name: z.string().min(1).max(80) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await requireOwner(req, id);
  if ("error" in r) return r.error;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid JSON" }, { status: 400 });
  }
  const parsed = CreateBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid body", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "scim_token",
          id,
          summary: `would mint SCIM token "${parsed.data.name}" for workspace ${id}`,
        }),
      ),
    );
  }
  const { plaintext, token } = await createToken(id, r.ctx.user.id, parsed.data.name);
  await recordAudit({
    action: "scim.token.create",
    target: token.id,
    outcome: "success",
    actor: { user_id: r.ctx.user.id, email: r.ctx.user.email },
    request: req,
    metadata: { workspace_id: id, name: token.name, prefix: token.prefix },
  });
  return NextResponse.json({ token, plaintext }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await requireOwner(req, id);
  if ("error" in r) return r.error;
  const url = new URL(req.url);
  const tokenId = url.searchParams.get("token");
  if (!tokenId) {
    return NextResponse.json({ detail: "missing ?token=" }, { status: 400 });
  }
  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "scim_token",
          id: tokenId,
          summary: `would revoke SCIM token ${tokenId} in workspace ${id}`,
        }),
      ),
    );
  }
  const ok = await revokeToken(id, tokenId);
  await recordAudit({
    action: "scim.token.revoke",
    target: tokenId,
    outcome: ok ? "success" : "failure",
    actor: { user_id: r.ctx.user.id, email: r.ctx.user.email },
    request: req,
    metadata: { workspace_id: id, found: ok },
  });
  if (!ok) {
    return NextResponse.json({ detail: "token not found or already revoked" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
