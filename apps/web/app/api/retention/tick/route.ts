/**
 * POST /api/retention/tick
 *
 * Workspace owner can invoke this to immediately purge runs that exceed
 * their configured `runs_retention_days`. Returns a structured result per
 * workspace. Every invocation is written to the dashboard audit log.
 *
 * Body:
 *   { "workspace_id": "ws_..." }
 *
 * Owner-only. Cross-tenant safe: a tick for workspace A can never touch
 * runs whose owner is not a current member of A. Supports ?dry_run=true.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { getWorkspaceForUser } from "@/lib/workspaces-store";
import { enforceRetention } from "@/lib/retention";
import { recordAudit } from "@/lib/dashboard-audit";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { listAllRuns } from "@/lib/runs-store";
import { listMembers, getWorkspacePolicy, normalizeRetentionDays } from "@/lib/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ workspace_id: z.string().min(1).max(64) });

export async function POST(req: NextRequest) {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json({ detail: "auth required" }, { status: 401 });
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
  const wsId = parsed.data.workspace_id;
  const ws = await getWorkspaceForUser(wsId, ctx.user.id);
  if (!ws) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }
  if (ws.role !== "owner") {
    await recordAudit({
      action: "workspace.retention.tick",
      target: wsId,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email },
      request: req,
      metadata: { reason: "not_owner", role: ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }

  if (isDryRun(req)) {
    // Compute what WOULD be purged without touching disk.
    const policy = await getWorkspacePolicy(wsId);
    const days = normalizeRetentionDays(
      (policy as { runs_retention_days?: unknown } | null)?.runs_retention_days,
    );
    if (!days) {
      return withDryRunHeaders(
        NextResponse.json(
          dryRunBody({
            resource: "workspace_runs",
            id: wsId,
            summary: "no retention policy set; nothing would be purged",
            before: { retention_days: null },
          }),
        ),
      );
    }
    const now = Date.now();
    const cutoff = now - days * 86_400_000;
    const members = await listMembers(wsId);
    const memberIds = new Set(members.map((m) => m.user_id));
    const all = await listAllRuns();
    const candidates = all.filter(
      (r) => r.user_id !== null && memberIds.has(r.user_id) && r.created_at < cutoff,
    );
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_runs",
          id: wsId,
          summary: `would purge ${candidates.length} run(s) older than ${days} day(s)`,
          before: {
            retention_days: days,
            cutoff_ms: cutoff,
            candidate_count: candidates.length,
          },
        }),
      ),
    );
  }

  const result = await enforceRetention(wsId);
  await recordAudit({
    action: "workspace.retention.tick",
    target: wsId,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email },
    request: req,
    metadata: result as unknown as Record<string, unknown>,
  });
  return NextResponse.json(result);
}
