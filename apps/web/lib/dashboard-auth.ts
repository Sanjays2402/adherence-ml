/**
 * Auth + audit helpers for dashboard-side mutating endpoints.
 *
 * Anything that mutates data, exports data, or destroys data must:
 *   1. Require a signed dashboard session, OR explicit dev opt-out.
 *   2. Land in the tamper-evident dashboard audit log.
 *
 * ADHERENCE_DASHBOARD_OPEN=1 bypasses the auth check for local development.
 * Production must leave it unset.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession, type SessionContext } from "./session";
import { recordAudit, type AuditOutcome } from "./dashboard-audit";
import { evaluateStepUp, stepUpDeniedResponse } from "./step-up";

export interface AuthContext {
  session: SessionContext | null;
  bypassed: boolean;
}

export function isDashboardOpen(): boolean {
  return process.env.ADHERENCE_DASHBOARD_OPEN === "1";
}

export async function requireDashboardAuth(
  req: NextRequest,
  opts: {
    action: string;
    target?: string | null;
    /**
     * When true, the caller must have proven a second factor recently
     * (see lib/step-up.ts). Used by destructive / trust-altering routes.
     */
    stepUp?: boolean;
    stepUpMaxAgeMs?: number;
  } = { action: "auth.required" },
): Promise<{ ok: true; ctx: AuthContext } | { ok: false; response: NextResponse }> {
  const session = await getSession(req);
  if (session) {
    if (opts.stepUp) {
      const decision = await evaluateStepUp(session, { maxAgeMs: opts.stepUpMaxAgeMs });
      if (!decision.ok) {
        await recordAudit({
          action: opts.action,
          target: opts.target ?? null,
          outcome: "denied",
          metadata: {
            reason: "mfa_step_up_required",
            step_up_reason: decision.reason ?? null,
          },
          actor: { user_id: session.user.id, email: session.user.email },
          request: req,
        });
        return {
          ok: false,
          response: stepUpDeniedResponse(decision, { maxAgeMs: opts.stepUpMaxAgeMs }),
        };
      }
    }
    return { ok: true, ctx: { session, bypassed: false } };
  }
  if (isDashboardOpen())
    return { ok: true, ctx: { session: null, bypassed: true } };
  await recordAudit({
    action: opts.action,
    target: opts.target ?? null,
    outcome: "denied",
    metadata: { reason: "no_session" },
    request: req,
  });
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: "unauthenticated",
        detail:
          "this endpoint requires a signed dashboard session; sign in or set ADHERENCE_DASHBOARD_OPEN=1 for local development",
      },
      { status: 401 },
    ),
  };
}

export async function auditAction(
  req: NextRequest,
  ctx: AuthContext,
  args: {
    action: string;
    target?: string | null;
    outcome?: AuditOutcome;
    metadata?: Record<string, unknown> | null;
  },
) {
  await recordAudit({
    action: args.action,
    target: args.target ?? null,
    outcome: args.outcome ?? "success",
    metadata: {
      ...(args.metadata ?? {}),
      ...(ctx.bypassed ? { _dev_bypass: true } : {}),
    },
    actor: ctx.session
      ? { user_id: ctx.session.user.id, email: ctx.session.user.email }
      : null,
    request: req,
  });
}
