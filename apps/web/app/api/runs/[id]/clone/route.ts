/**
 * GET /api/runs/[id]/clone
 *
 * Returns the inputs needed to re-run a previously saved prediction.
 * The /predict page reads this via ?from=<runId> and prefills its
 * form, so users can iterate on a past run without retyping doses.
 *
 * 404 if the run id does not exist. 422 if the run kind cannot be
 * cloned (only predict/demo carry the schedule payload today).
 */
import { NextResponse } from "next/server";
import { getRun } from "@/lib/runs-store";
import { cloneFromRun, isCloneable } from "@/lib/run-clone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await getRun(id);
  if (!rec) {
    return NextResponse.json(
      { error: "not_found", detail: `run ${id} not found` },
      { status: 404 },
    );
  }
  if (!isCloneable(rec)) {
    return NextResponse.json(
      {
        error: "not_cloneable",
        detail: `run kind '${rec.kind}' has no replayable schedule payload`,
      },
      { status: 422 },
    );
  }
  const inputs = cloneFromRun(rec);
  if (!inputs) {
    return NextResponse.json(
      { error: "not_cloneable", detail: "payload missing schedule" },
      { status: 422 },
    );
  }
  return NextResponse.json({
    source_run_id: rec.id,
    kind: rec.kind,
    inputs,
  });
}
