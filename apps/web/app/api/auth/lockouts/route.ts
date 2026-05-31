/**
 * Workspace-admin view of current login throttle state.
 *
 *   GET  /api/auth/lockouts                       -> list active buckets
 *   GET  /api/auth/lockouts?only_locked=1         -> only currently locked
 *   POST /api/auth/lockouts/clear { scope, key }  -> wipe one bucket
 *
 * Available to any signed-in dashboard session so a workspace owner can
 * see who is being throttled and clear false positives. Every clear lands
 * in the dashboard audit log.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  clearByAdmin,
  listBuckets,
  type ThrottleScope,
} from "@/lib/login-throttle";
import { requireDashboardAuth, auditAction } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ClearBody = z.object({
  scope: z.enum(["magic_request", "totp_verify"]),
  key: z.string().min(1).max(254),
});

export async function GET(req: NextRequest) {
  const guard = await requireDashboardAuth(req, {
    action: "auth.lockouts.list",
  });
  if (!guard.ok) return guard.response;
  const onlyLocked = req.nextUrl.searchParams.get("only_locked") === "1";
  const buckets = await listBuckets({ onlyLocked });
  return NextResponse.json({
    now: Date.now(),
    only_locked: onlyLocked,
    count: buckets.length,
    buckets,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireDashboardAuth(req, {
    action: "auth.lockouts.clear",
  });
  if (!guard.ok) return guard.response;
  let parsed: { scope: ThrottleScope; key: string };
  try {
    parsed = ClearBody.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "invalid_body", detail: "body must be { scope, key }" },
      { status: 400 },
    );
  }
  const removed = await clearByAdmin(parsed.scope, parsed.key);
  await auditAction(req, guard.ctx, {
    action: "auth.lockouts.clear",
    target: `${parsed.scope}:${parsed.key}`,
    outcome: removed ? "success" : "failure",
    metadata: { scope: parsed.scope, key: parsed.key, removed },
  });
  if (!removed) {
    return NextResponse.json(
      { ok: false, removed: false, detail: "no matching bucket" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, removed: true });
}
