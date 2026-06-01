/**
 * Expiring-soon API key warning endpoint.
 *
 *   GET /api/keys/expiring?within=14
 *
 * Returns every live (not revoked, not already expired) API key whose
 * `expires_at` falls inside the requested lookahead window, nearest to
 * expiry first. Operators use this to schedule rotations before the
 * 3 a.m. outage where an integration silently 401s because a forgotten
 * key crossed its TTL boundary.
 *
 * Dashboard-auth only: anyone with a workspace session can read this
 * (it returns no secret material, only prefixes and scopes). Every
 * call is written to the dashboard audit log so a tampered list,
 * a never-pulled list, or a "who looked at my keys" question all
 * remain answerable after the fact. No mutation, no audit diff.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_EXPIRING_SOON_WINDOW_DAYS,
  MAX_EXPIRING_SOON_WINDOW_DAYS,
  findExpiringSoon,
} from "@/lib/api-keys-store";
import { requireDashboardAuth, auditAction } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseWindow(raw: string | null): {
  value: number;
  clamped: boolean;
  invalid: boolean;
} {
  if (raw === null || raw === undefined || raw === "") {
    return { value: DEFAULT_EXPIRING_SOON_WINDOW_DAYS, clamped: false, invalid: false };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { value: DEFAULT_EXPIRING_SOON_WINDOW_DAYS, clamped: false, invalid: true };
  }
  const floored = Math.floor(n);
  if (floored > MAX_EXPIRING_SOON_WINDOW_DAYS) {
    return { value: MAX_EXPIRING_SOON_WINDOW_DAYS, clamped: true, invalid: false };
  }
  return { value: floored, clamped: false, invalid: false };
}

export async function GET(req: NextRequest) {
  const guard = await requireDashboardAuth(req, {
    action: "api_keys.expiring.list",
  });
  if (!guard.ok) return guard.response;

  const parsed = parseWindow(req.nextUrl.searchParams.get("within"));
  if (parsed.invalid) {
    return NextResponse.json(
      {
        error: "invalid_window",
        detail: "within must be a positive integer number of days",
        max_window_days: MAX_EXPIRING_SOON_WINDOW_DAYS,
      },
      { status: 400 },
    );
  }

  const now = Date.now();
  const items = await findExpiringSoon(parsed.value, now);

  await auditAction(req, guard.ctx, {
    action: "api_keys.expiring.list",
    target: `within=${parsed.value}`,
    outcome: "success",
    metadata: {
      within_days: parsed.value,
      window_clamped: parsed.clamped,
      count: items.length,
    },
  });

  return NextResponse.json({
    now,
    within_days: parsed.value,
    window_clamped: parsed.clamped,
    max_window_days: MAX_EXPIRING_SOON_WINDOW_DAYS,
    count: items.length,
    keys: items,
  });
}
