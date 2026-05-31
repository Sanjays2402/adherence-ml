import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  claimDomain,
  listVerifiedDomains,
  getWorkspaceForUser,
  publicVerifiedDomain,
} from "@/lib/workspaces-store";
import { recordAudit } from "@/lib/dashboard-audit";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ClaimSchema = z.object({
  domain: z.string().min(3).max(253),
  default_role: z.enum(["editor", "viewer"]).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  const list = await listVerifiedDomains(id);
  return NextResponse.json({
    role: ws.role,
    domains: list.map(publicVerifiedDomain),
  });
}

export async function POST(
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
      action: "workspace.domain.claim",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: "not_owner", caller_role: ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = ClaimSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_domain",
          id: `${id}:${parsed.data.domain.toLowerCase()}`,
          summary: `claim domain ${parsed.data.domain.toLowerCase()} for workspace '${ws.workspace.name}'; you must publish a TXT record to verify before auto-join is allowed`,
        }),
      ),
    );
  }
  const r = await claimDomain(
    id,
    ctx.user.id,
    parsed.data.domain,
    parsed.data.default_role ?? "viewer",
  );
  if (typeof r === "string") {
    const status =
      r === "forbidden" ? 403 :
      r === "not_found" ? 404 :
      r === "already_verified_elsewhere" ? 409 : 400;
    await recordAudit({
      action: "workspace.domain.claim",
      target: `${id}:${parsed.data.domain}`,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: r, domain: parsed.data.domain },
    });
    return NextResponse.json({ detail: r }, { status });
  }
  await recordAudit({
    action: "workspace.domain.claim",
    target: `${id}:${r.domain}`,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: {
      workspace_id: id,
      domain: r.domain,
      default_role: r.default_role,
    },
  });
  return NextResponse.json({ ok: true, domain: publicVerifiedDomain(r) });
}
