/**
 * Signed audit evidence bundle.
 *
 * Returns the full append-only dashboard audit log as a single JSON document
 * (`adherence.audit.bundle.v1`) with a manifest, the integrity report, and
 * every entry in chronological order. The manifest carries a SHA-256 root
 * over the concatenation of every entry hash so a buyer's security team can
 * detect any post-export tampering by recomputing the root locally.
 *
 * Owner-only is enforced when the caller passes `?workspace_id=...`; without
 * a workspace context any signed dashboard session may export their own
 * audit evidence. The export is itself recorded as an audit entry so the
 * tip hash advances by one immediately after the bundle is generated.
 */
import { NextRequest, NextResponse } from "next/server";
import { exportAuditBundle } from "@/lib/dashboard-audit";
import { auditAction, requireDashboardAuth } from "@/lib/dashboard-auth";
import { getWorkspaceForUser } from "@/lib/workspaces-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireDashboardAuth(req, {
    action: "audit.bundle.export",
  });
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const wsId = url.searchParams.get("workspace_id");

  if (wsId) {
    const userId = auth.ctx.session?.user.id;
    if (!userId) {
      return NextResponse.json(
        { detail: "workspace export requires signed session" },
        { status: 401 },
      );
    }
    const ws = await getWorkspaceForUser(wsId, userId);
    if (!ws) {
      return NextResponse.json({ detail: "not found" }, { status: 404 });
    }
    if (ws.role !== "owner") {
      await auditAction(req, auth.ctx, {
        action: "audit.bundle.export",
        target: wsId,
        outcome: "denied",
        metadata: { reason: "not_owner", caller_role: ws.role },
      });
      return NextResponse.json({ detail: "owner only" }, { status: 403 });
    }
  }

  const bundle = await exportAuditBundle({ workspace_id: wsId });

  await auditAction(req, auth.ctx, {
    action: "audit.bundle.export",
    target: wsId ?? "dashboard-audit.jsonl",
    outcome: "success",
    metadata: {
      entry_count: bundle.manifest.entry_count,
      tip_hash: bundle.manifest.tip_hash,
      entries_root: bundle.manifest.entries_root,
      chain_valid: bundle.report.chain_valid,
    },
  });

  const body = JSON.stringify(bundle, null, 2);
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="audit-bundle-${stamp}.json"`,
      "cache-control": "no-store",
      "x-audit-bundle-schema": bundle.manifest.schema,
      "x-audit-tip-hash": bundle.manifest.tip_hash ?? "",
      "x-audit-entries-root": bundle.manifest.entries_root,
      "x-audit-entry-count": String(bundle.manifest.entry_count),
      "x-audit-chain-valid": String(bundle.report.chain_valid),
    },
  });
}
