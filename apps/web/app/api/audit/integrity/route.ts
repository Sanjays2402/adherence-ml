/**
 * Dashboard audit chain integrity report.
 *
 * Recomputes every entry's SHA-256, confirms each prev_hash linkage, and
 * returns a structured report a SOC2 auditor can attach as evidence. The
 * computation itself is recorded back to the audit log so the verification
 * is itself audited (action: audit.integrity.verify).
 *
 * Auth: dashboard session required (same gate as /api/audit/dashboard).
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAuditChain } from "@/lib/dashboard-audit";
import { auditAction, requireDashboardAuth } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireDashboardAuth(req, {
    action: "audit.integrity.verify",
  });
  if (!auth.ok) return auth.response;

  const report = await verifyAuditChain();

  await auditAction(req, auth.ctx, {
    action: "audit.integrity.verify",
    target: "dashboard-audit.jsonl",
    outcome: report.chain_valid ? "success" : "failure",
    metadata: {
      entries: report.entries,
      tip_hash: report.tip_hash,
      first_break_index: report.first_break_index,
      first_break_id: report.first_break_id,
      first_break_reason: report.first_break_reason,
      has_corrupt_lines: report.has_corrupt_lines,
    },
  });

  return NextResponse.json(report, {
    headers: {
      "cache-control": "no-store",
      "x-audit-chain-valid": String(report.chain_valid),
      "x-audit-tip-hash": report.tip_hash ?? "",
      "x-audit-entry-count": String(report.entries),
    },
  });
}
