import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runs-store";
import { runToPdf } from "@/lib/run-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "run"
  );
}

/**
 * Per-run PDF report. Renders a single-page printable summary of the run
 * (title, kind, timestamp, risk score when present, and truncated payload).
 * Companion to the existing JSON download at /api/runs/[id]/download.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await getRun(id);
  if (!rec) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const origin = req.nextUrl.origin;
  const bytes = runToPdf(rec, { origin });
  const stamp = new Date(rec.created_at)
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const filename = `adherence-${rec.kind}-${safeName(rec.title)}-${stamp}.pdf`;
  const body = new Uint8Array(bytes);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(body.byteLength),
      "cache-control": "private, no-store",
    },
  });
}
