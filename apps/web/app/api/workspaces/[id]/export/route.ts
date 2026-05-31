import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  buildWorkspaceExport,
  previewWorkspaceExport,
  runsCsv,
} from "@/lib/workspace-export";
import { recordAudit } from "@/lib/dashboard-audit";
import { isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { withResidencyHeaders } from "@/lib/residency";
import { getWorkspaceForUser, publicPolicy } from "@/lib/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Format = "json" | "csv";

function parseFormat(req: NextRequest): Format {
  const f = (req.nextUrl.searchParams.get("format") ?? "json").toLowerCase();
  return f === "csv" ? "csv" : "json";
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json({ detail: "auth required" }, { status: 401 });
  }
  const { id } = await params;

  // Resolve residency early so headers reflect the workspace policy on every
  // response (success, denied, not_found).
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  const residency = publicPolicy(ws?.workspace.security_policy ?? null)
    .data_residency;

  if (isDryRun(req)) {
    const preview = await previewWorkspaceExport(id, ctx.user.id);
    if (preview === null) {
      return NextResponse.json({ detail: "not found" }, { status: 404 });
    }
    if (preview === "forbidden") {
      await recordAudit({
        action: "workspace.export.preview",
        target: id,
        outcome: "denied",
        actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
        request: req,
        metadata: { reason: "not_owner" },
      });
      return NextResponse.json({ detail: "owner only" }, { status: 403 });
    }
    await recordAudit({
      action: "workspace.export.preview",
      target: id,
      outcome: "success",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { counts: preview.counts },
    });
    return withDryRunHeaders(
      withResidencyHeaders(NextResponse.json({ dry_run: true, manifest: preview }), residency),
    );
  }

  const bundle = await buildWorkspaceExport(id, ctx.user.id);
  if (bundle === null) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }
  if (bundle === "forbidden") {
    await recordAudit({
      action: "workspace.export.download",
      target: id,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
      request: req,
      metadata: { reason: "not_owner" },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }

  await recordAudit({
    action: "workspace.export.download",
    target: id,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email ?? null },
    request: req,
    metadata: { counts: bundle.manifest.counts, format: parseFormat(req) },
  });

  const fmt = parseFormat(req);
  const safeName = bundle.workspace.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || bundle.workspace.id;
  const stamp = new Date(bundle.manifest.generated_at)
    .toISOString()
    .replace(/[:.]/g, "-");

  if (fmt === "csv") {
    const csv = runsCsv(bundle.runs);
    const res = new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${safeName}-runs-${stamp}.csv"`,
        "x-export-schema-version": String(bundle.manifest.schema_version),
        "x-export-rows": String(bundle.runs.length),
      },
    });
    return withResidencyHeaders(res, residency);
  }

  const body = JSON.stringify(bundle, null, 2);
  const res = new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${safeName}-export-${stamp}.json"`,
      "x-export-schema-version": String(bundle.manifest.schema_version),
    },
  });
  return withResidencyHeaders(res, residency);
}
