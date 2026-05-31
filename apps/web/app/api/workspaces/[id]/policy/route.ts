/**
 * Workspace security policy: configurable session TTL cap and require-MFA
 * toggle. Owner-only writes; any member can read. Every mutation is appended
 * to the hash-chained dashboard audit log so a CISO can verify the timeline.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  POLICY_MAX_SESSION_MINUTES,
  POLICY_MIN_SESSION_MINUTES,
  getWorkspaceForUser,
  publicPolicy,
  setWorkspacePolicy,
} from "@/lib/workspaces-store";
import { recordAudit } from "@/lib/dashboard-audit";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  session_max_age_minutes: z
    .number()
    .int()
    .min(POLICY_MIN_SESSION_MINUTES)
    .max(POLICY_MAX_SESSION_MINUTES)
    .nullable(),
  require_mfa: z.boolean(),
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
  return NextResponse.json({
    policy: publicPolicy(ws.workspace.security_policy),
    role: ws.role,
    limits: {
      min_session_minutes: POLICY_MIN_SESSION_MINUTES,
      max_session_minutes: POLICY_MAX_SESSION_MINUTES,
    },
  });
}

export async function PUT(
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
      action: "workspace.policy.update",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email },
      request: req,
      metadata: { reason: "not_owner", role: ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid body", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const before = publicPolicy(ws.workspace.security_policy);
  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_security_policy",
          id,
          summary: "would update workspace security policy",
          before: before as unknown as Record<string, unknown>,
        }),
      ),
    );
  }
  try {
    const after = await setWorkspacePolicy(id, ctx.user.id, parsed.data);
    await recordAudit({
      action: "workspace.policy.update",
      target: id,
      outcome: "success",
      actor: { user_id: ctx.user.id, email: ctx.user.email },
      request: req,
      metadata: { before: before as unknown as Record<string, unknown>, after: after as unknown as Record<string, unknown> },
    });
    return NextResponse.json({ policy: after });
  } catch (err) {
    const message = err instanceof Error ? err.message : "policy update failed";
    return NextResponse.json({ detail: message }, { status: 400 });
  }
}
