/**
 * Dashboard audit log query endpoint. Distinct from /api/audit/list which
 * proxies to the FastAPI prediction audit; this one surfaces dashboard-side
 * mutations recorded by lib/dashboard-audit.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { listAudit } from "@/lib/dashboard-audit";
import { requireDashboardAuth } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireDashboardAuth(req, { action: "audit.dashboard.read" });
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
  const action = url.searchParams.get("action") ?? undefined;
  const actor = url.searchParams.get("actor_user_id") ?? undefined;
  const outcome = url.searchParams.get("outcome") as
    | "success"
    | "failure"
    | "denied"
    | null;
  const sinceRaw = url.searchParams.get("since_ms");

  const baseOpts = {
    limit: Number.isFinite(limit) ? Math.min(limit, 1000) : 100,
    action,
    actor_user_id: actor,
    outcome: outcome ?? undefined,
    since_ms: sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined,
  };

  if (url.searchParams.get("format") === "jsonl") {
    const result = await listAudit(baseOpts);
    const body = result.items.map((e) => JSON.stringify(e)).join("\n");
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="dashboard-audit-${new Date()
          .toISOString()
          .slice(0, 10)}.jsonl"`,
      },
    });
  }

  const result = await listAudit(baseOpts);
  return NextResponse.json(result);
}
