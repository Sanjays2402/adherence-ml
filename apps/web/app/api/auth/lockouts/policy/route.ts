/**
 * Per-deployment login-throttle policy.
 *
 *   GET  /api/auth/lockouts/policy
 *     -> { policies: { magic_request, totp_verify }, bounds, updated_at, updated_by }
 *
 *   PUT  /api/auth/lockouts/policy
 *     body: { policies: { [scope]: { windowMs, maxAttempts, lockoutMs } | null } }
 *     -> same shape as GET. Passing null for a scope reverts it to the
 *        built-in default. Out-of-range values are clamped server-side.
 *
 * Anyone with a dashboard session can read; mutations require a session
 * and are recorded in the dashboard audit log so security reviewers can
 * tell when the lockout window or threshold was tuned and by whom.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DEFAULT_POLICIES,
  POLICY_BOUNDS,
  getPolicies,
  setPolicies,
  type ThrottlePolicy,
  type ThrottleScope,
} from "@/lib/login-throttle";
import { requireDashboardAuth, auditAction } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PolicyShape = z.object({
  windowMs: z
    .number()
    .int()
    .min(POLICY_BOUNDS.windowMs.min)
    .max(POLICY_BOUNDS.windowMs.max),
  maxAttempts: z
    .number()
    .int()
    .min(POLICY_BOUNDS.maxAttempts.min)
    .max(POLICY_BOUNDS.maxAttempts.max),
  lockoutMs: z
    .number()
    .int()
    .min(POLICY_BOUNDS.lockoutMs.min)
    .max(POLICY_BOUNDS.lockoutMs.max),
});

const PutBody = z.object({
  policies: z
    .object({
      magic_request: PolicyShape.nullable().optional(),
      totp_verify: PolicyShape.nullable().optional(),
    })
    .refine(
      (p) => p.magic_request !== undefined || p.totp_verify !== undefined,
      { message: "at least one scope must be provided" },
    ),
});

function principalFromCtx(ctx: {
  session: { user?: { email?: string | null } | null } | null;
  bypassed: boolean;
}): string {
  if (ctx.bypassed) return "dashboard-open";
  return ctx.session?.user?.email ?? "unknown";
}

export async function GET(req: NextRequest) {
  const guard = await requireDashboardAuth(req, {
    action: "auth.lockouts.policy.read",
  });
  if (!guard.ok) return guard.response;
  const view = await getPolicies();
  return NextResponse.json({
    ...view,
    defaults: DEFAULT_POLICIES,
  });
}

export async function PUT(req: NextRequest) {
  const guard = await requireDashboardAuth(req, {
    action: "auth.lockouts.policy.update",
  });
  if (!guard.ok) return guard.response;

  let parsed: { policies: Partial<Record<ThrottleScope, ThrottlePolicy | null>> };
  try {
    parsed = PutBody.parse(await req.json()) as typeof parsed;
  } catch (err) {
    const detail =
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid body" : "invalid body";
    return NextResponse.json(
      { error: "invalid_body", detail },
      { status: 400 },
    );
  }

  const before = await getPolicies();
  const view = await setPolicies(parsed.policies, principalFromCtx(guard.ctx));
  await auditAction(req, guard.ctx, {
    action: "auth.lockouts.policy.update",
    target: Object.keys(parsed.policies).join(","),
    outcome: "success",
    metadata: {
      before: Object.fromEntries(
        Object.entries(before.policies).map(([k, v]) => [
          k,
          { source: v.source, windowMs: v.windowMs, maxAttempts: v.maxAttempts, lockoutMs: v.lockoutMs },
        ]),
      ),
      after: Object.fromEntries(
        Object.entries(view.policies).map(([k, v]) => [
          k,
          { source: v.source, windowMs: v.windowMs, maxAttempts: v.maxAttempts, lockoutMs: v.lockoutMs },
        ]),
      ),
    },
  });
  return NextResponse.json({ ...view, defaults: DEFAULT_POLICIES });
}
