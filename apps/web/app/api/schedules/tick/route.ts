/**
 * Cron tick endpoint: fires every schedule whose next_run_at is in the past.
 *
 * Intended to be poked by an external scheduler (Vercel Cron, GitHub Actions,
 * a plain `curl` from crond). Protected by an optional shared secret in the
 * ADHERENCE_CRON_SECRET env var; when unset, anyone on localhost can tick,
 * which matches the dev posture of the rest of the stack.
 *
 *   curl -X POST http://localhost:3000/api/schedules/tick \
 *     -H "x-cron-secret: $ADHERENCE_CRON_SECRET"
 */
import { NextRequest, NextResponse } from "next/server";
import { listDue } from "@/lib/schedules-store";
import { fireSchedule } from "@/lib/schedule-fire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const expected = process.env.ADHERENCE_CRON_SECRET;
  if (!expected) return true;
  const got = req.headers.get("x-cron-secret") ?? "";
  return got === expected;
}

async function tick(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const due = await listDue();
  const results = [];
  for (const sch of due) {
    const r = await fireSchedule(sch);
    results.push({ schedule_id: sch.id, ok: r.ok, run_id: r.run_id, error: r.error });
  }
  return NextResponse.json({
    fired: results.length,
    results,
    ts: Date.now(),
  });
}

export async function POST(req: NextRequest) {
  return tick(req);
}

export async function GET(req: NextRequest) {
  // GET is convenient for `curl` and for Vercel Cron which fires GET.
  return tick(req);
}
