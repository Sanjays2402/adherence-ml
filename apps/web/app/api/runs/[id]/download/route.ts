import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runs-store";

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
 * Per-run download. Returns the full RunRecord (including payload) as
 * pretty-printed JSON with a content-disposition attachment header so the
 * browser saves it. Used by the history detail page.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await getRun(id);
  if (!rec) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const stamp = new Date(rec.created_at)
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const filename = `adherence-${rec.kind}-${safeName(rec.title)}-${stamp}.json`;
  return new NextResponse(JSON.stringify(rec, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
