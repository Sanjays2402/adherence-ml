/**
 * POST /api/workspaces/:id/delete
 *
 * Owner-initiated full workspace deletion (tenant offboarding).
 *
 * Procurement asks for this under GDPR Art. 17 ("right to erasure") and
 * SOC2 CC6.1 (logical access removal on offboarding). It is the workspace
 * sibling of the existing per-user account erasure flow.
 *
 * Guarantees:
 *   - Owner-only. Any other role gets 403 with an audited "denied" row.
 *   - Step-up MFA required on the real call. Dry-run is allowed without
 *     step-up so owners can preview the impact.
 *   - Typed confirmation phrase ("DELETE WORKSPACE <name>") required.
 *   - `?dry_run=true` returns the manifest with no mutation.
 *   - Cross-tenant safe: every cascade filter is keyed on workspace_id.
 *   - Every outcome (success or denied) lands in the tamper-evident
 *     dashboard audit log.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { recordAudit } from "@/lib/dashboard-audit";
import { requireRecentMfa } from "@/lib/step-up";
import {
  executeWorkspaceDeletion,
  previewWorkspaceDeletion,
  workspaceDeleteConfirmPhrase,
} from "@/lib/workspace-delete";
import { getWorkspaceForUser } from "@/lib/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  confirm: z.string().min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx)
    return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;

  // Resolve membership early so we can give the same 404 for "not a member"
  // as for "no such workspace" (do not leak existence to non-members).
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws)
    return NextResponse.json({ detail: "not found" }, { status: 404 });

  if (ws.role !== "owner") {
    await recordAudit({
      action: "workspace.delete",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: "not_owner", caller_role: ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }

  if (isDryRun(req)) {
    const preview = await previewWorkspaceDeletion(id, ctx.user.id);
    if (preview === null)
      return NextResponse.json({ detail: "not found" }, { status: 404 });
    if (preview === "forbidden")
      return NextResponse.json({ detail: "owner only" }, { status: 403 });
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace",
          id,
          summary:
            `permanently delete workspace '${preview.workspace_name}' ` +
            `(${preview.members.length} member(s), ${preview.invites_open} open invite(s), ` +
            `${preview.verified_domains} verified domain(s)); ` +
            `every member loses access immediately and this cannot be undone`,
          before: {
            workspace_id: id,
            workspace_name: preview.workspace_name,
            members: preview.members,
            invites_open: preview.invites_open,
            invites_total: preview.invites_total,
            verified_domains: preview.verified_domains,
            sso_configured: preview.sso_configured,
            security_policy_set: preview.security_policy_set,
            confirm_phrase: preview.confirm_phrase,
          },
          cascade: [
            ...preview.members.map((m) => ({
              resource: "workspace_member" as const,
              id: `${id}:${m.user_id}`,
              label: `${m.email ?? m.user_id} (${m.role})`,
            })),
            {
              resource: "workspace_invites" as const,
              id: `${id}:invites`,
              label: `${preview.invites_total} invite record(s)`,
            },
            {
              resource: "workspace_verified_domains" as const,
              id: `${id}:domains`,
              label: `${preview.verified_domains} verified domain(s)`,
            },
            {
              resource: "workspace_scim_tokens" as const,
              id: `${id}:scim`,
              label: "all SCIM tokens scoped to this workspace",
            },
          ],
        }),
      ),
    );
  }

  // Real deletion: require fresh second factor when the caller has one.
  const step = await requireRecentMfa(req, ctx);
  if (!step.ok) {
    await recordAudit({
      action: "workspace.delete",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: {
        reason: "mfa_step_up_required",
        step_up_reason: step.decision.reason ?? null,
      },
    });
    return step.response;
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

  const expected = workspaceDeleteConfirmPhrase(ws.workspace.name);
  if (parsed.data.confirm !== expected) {
    await recordAudit({
      action: "workspace.delete",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: {
        reason: "bad_confirm",
        workspace_id: id,
        workspace_name: ws.workspace.name,
      },
    });
    return NextResponse.json(
      {
        detail:
          'destructive action requires {"confirm":"' +
          expected +
          '"} in the request body',
        confirm_phrase: expected,
      },
      { status: 400 },
    );
  }

  const result = await executeWorkspaceDeletion(
    id,
    ctx.user.id,
    parsed.data.confirm,
  );
  if (typeof result === "string") {
    const status =
      result === "forbidden" ? 403 : result === "not_found" ? 404 : 400;
    await recordAudit({
      action: "workspace.delete",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: {
        workspace_id: id,
        workspace_name: ws.workspace.name,
        reason: result,
      },
    });
    return NextResponse.json({ detail: result }, { status });
  }

  await recordAudit({
    action: "workspace.delete",
    target: id,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: {
      workspace_id: id,
      workspace_name: result.workspace_name,
      members_removed: result.members_removed,
      invites_removed: result.invites_removed,
      verified_domains_removed: result.verified_domains_removed,
      sso_removed: result.sso_removed,
      security_policy_removed: result.security_policy_removed,
      scim_tokens_removed: result.scim_tokens_removed,
    },
  });
  return NextResponse.json({ ok: true, ...result });
}
