/**
 * Step-up MFA gate for sensitive admin actions.
 *
 * Enterprise procurement (SOC2 CC6.1, HIPAA 164.312(d)) routinely demands
 * that destructive or trust-altering actions require a fresh second-factor
 * proof, not just a long-lived signed session cookie. This module implements
 * that gate as a small helper so every sensitive route enforces the same
 * policy with the same error shape.
 *
 * Rules
 *   - If the user has TOTP enrolled (totp_enabled && totp_secret), the
 *     session's `last_mfa_at` must be within STEP_UP_MAX_AGE_MS to pass.
 *   - If any workspace the user belongs to enforces require_mfa, the gate
 *     is mandatory even if the user has not yet enrolled (the user will be
 *     forced through enrollment by the existing mfa_required_but_missing
 *     check on login, but we belt-and-brace it here too).
 *   - Otherwise the gate is a no-op so single-user dev / pre-2FA workspaces
 *     are not locked out of their own admin actions.
 *
 * On failure, returns a 403 with a structured body the client can parse:
 *   {
 *     "error": "mfa_step_up_required",
 *     "code": "mfa_step_up_required",
 *     "detail": "...",
 *     "step_up": {
 *       "max_age_seconds": 600,
 *       "last_mfa_at": 1717100000000 | null,
 *       "totp_enrolled": true | false,
 *       "verify_url": "/api/auth/2fa/step-up"
 *     }
 *   }
 *
 * Callers should also append the response to the dashboard audit log with
 * outcome "denied", reason "mfa_step_up_required" so a CISO can see refused
 * attempts on the audit timeline.
 */
import { NextRequest, NextResponse } from "next/server";
import type { SessionContext } from "./session";
import { getSessionRecord } from "./sessions-store";
import { effectivePolicyForUser } from "./workspaces-store";

/** How long a fresh 2FA proof is considered valid for sensitive actions. */
export const STEP_UP_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
export const STEP_UP_VERIFY_URL = "/api/auth/2fa/step-up";

export type StepUpReason =
  | "mfa_not_enrolled"
  | "no_recent_mfa"
  | "no_session_record";

export interface StepUpDecision {
  ok: boolean;
  reason?: StepUpReason;
  lastMfaAt: number | null;
  totpEnrolled: boolean;
  policyRequires: boolean;
}

export async function evaluateStepUp(
  ctx: SessionContext,
  opts: { maxAgeMs?: number } = {},
): Promise<StepUpDecision> {
  const maxAgeMs = opts.maxAgeMs ?? STEP_UP_MAX_AGE_MS;
  const user = ctx.user;
  const totpEnrolled = Boolean(user.totp_enabled && user.totp_secret);

  // Resolve whether any workspace the user is in mandates MFA. We only
  // need this to decide whether to enforce when the user has not enrolled.
  let policyRequires = false;
  try {
    const pol = await effectivePolicyForUser(user.id);
    policyRequires = Boolean(pol.require_mfa);
  } catch {
    policyRequires = false;
  }

  if (!totpEnrolled && !policyRequires) {
    // No second factor available and no workspace mandates one: gate is a
    // no-op. The action proceeds with normal session auth.
    return { ok: true, lastMfaAt: null, totpEnrolled, policyRequires };
  }
  if (!totpEnrolled && policyRequires) {
    // Workspace policy says MFA required but user has no TOTP. Block.
    return {
      ok: false,
      reason: "mfa_not_enrolled",
      lastMfaAt: null,
      totpEnrolled,
      policyRequires,
    };
  }

  // TOTP is enrolled. Pull the per-session record to read last_mfa_at.
  const sid = ctx.payload.sid;
  if (!sid) {
    return {
      ok: false,
      reason: "no_session_record",
      lastMfaAt: null,
      totpEnrolled,
      policyRequires,
    };
  }
  const rec = await getSessionRecord(sid);
  if (!rec) {
    return {
      ok: false,
      reason: "no_session_record",
      lastMfaAt: null,
      totpEnrolled,
      policyRequires,
    };
  }
  const lastMfaAt = rec.last_mfa_at ?? null;
  if (lastMfaAt && Date.now() - lastMfaAt < maxAgeMs) {
    return { ok: true, lastMfaAt, totpEnrolled, policyRequires };
  }
  return {
    ok: false,
    reason: "no_recent_mfa",
    lastMfaAt,
    totpEnrolled,
    policyRequires,
  };
}

export function stepUpDeniedResponse(
  decision: StepUpDecision,
  opts: { maxAgeMs?: number } = {},
): NextResponse {
  const maxAgeMs = opts.maxAgeMs ?? STEP_UP_MAX_AGE_MS;
  const detail =
    decision.reason === "mfa_not_enrolled"
      ? "this action requires a second factor; enroll a TOTP authenticator in settings before retrying"
      : "this action requires a fresh second factor proof; enter your TOTP code to continue";
  return NextResponse.json(
    {
      error: "mfa_step_up_required",
      code: "mfa_step_up_required",
      detail,
      step_up: {
        max_age_seconds: Math.floor(maxAgeMs / 1000),
        last_mfa_at: decision.lastMfaAt,
        totp_enrolled: decision.totpEnrolled,
        policy_requires_mfa: decision.policyRequires,
        verify_url: STEP_UP_VERIFY_URL,
        reason: decision.reason ?? null,
      },
    },
    { status: 403 },
  );
}

/**
 * Convenience: combine the check and the response into a single guard for
 * route handlers. Returns `{ ok: true }` on pass, `{ ok: false, response }`
 * on fail so callers can early-return.
 */
export async function requireRecentMfa(
  _req: NextRequest,
  ctx: SessionContext,
  opts: { maxAgeMs?: number } = {},
): Promise<{ ok: true; decision: StepUpDecision } | { ok: false; response: NextResponse; decision: StepUpDecision }> {
  const decision = await evaluateStepUp(ctx, opts);
  if (decision.ok) return { ok: true, decision };
  return { ok: false, response: stepUpDeniedResponse(decision, opts), decision };
}
