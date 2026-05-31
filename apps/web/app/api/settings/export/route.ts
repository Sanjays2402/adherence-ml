import { NextRequest, NextResponse } from "next/server";
import { exportAllData } from "@/lib/settings-store";
import { requireDashboardAuth, auditAction } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireDashboardAuth(req, { action: "settings.export" });
  if (!auth.ok) return auth.response;
  const bundle = await exportAllData();
  const filename = `adherence-export-${new Date().toISOString().slice(0, 10)}.json`;
  await auditAction(req, auth.ctx, {
    action: "settings.export",
    target: "workspace.bundle",
    metadata: {
      byte_length: Buffer.byteLength(JSON.stringify(bundle)),
      top_level_keys: Object.keys(bundle as Record<string, unknown>),
    },
  });
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
