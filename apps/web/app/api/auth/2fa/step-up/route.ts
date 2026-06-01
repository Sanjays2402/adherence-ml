/**
 * POST /api/auth/2fa/step-up
 *
 * Accepts a fresh TOTP code from an already-signed-in user and stamps the
 * session's `last_mfa_at` so subsequent sensitive admin actions
 * (api-key issue / rotate / revoke, ownership transfer, account erasure,
 * data wipe) clear the step-up gate for STEP_UP_MAX_AGE_MS.
 *
 * This is NOT a login route. It refuses unauthenticated callers and
 * users without TOTP enrolled. The wider login MFA challenge lives at
 * /api/auth/2fa/verify; this endpoint exists solely to renew the
 * step-up window without forcing the user to sign out.
 *
 * Body
 *   { "code": "123456" } | { "recovery": "abcd-efgh" }
 *
 * Responses
 *   200 { ok: true, last_mfa_at, max_age_seconds, recovery_codes_remaining }
 *   400 { error: "bad_request" }
 *   401 { error: "unauthenticated" | "mfa_not_enrolled" | "no_session_record" }
 *   401 { error: "invalid_code" }
 *   429 { error: "locked_out", retry_after_seconds }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { consumeRecoveryCode, getUserById } from "@/lib/users-store";
import { markSessionMfa } from "@/lib/sessions-store";
import { verifyTotp } from "@/lib/totp";
import { recordAuthEvent } from "@/lib/auth-audit";
import { recordAudit } from "@/lib/dashboard-audit";
import { STEP_UP_MAX_AGE_MS } from "@/lib/step-up";
import {
  checkLockout,
  clearBucket,
  clientIpFromRequest,
  recordFailure,
} from "@/lib/login-throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  code: z.string().trim().regex(/^\d{6}$/u).optional(),
  recovery: z.string().trim().min(4).max(64).optional(),
});

export async function POST(req: NextRequest) {
  const ctx = await getSession(req);
  if (!ctx) {
    return NextResponse.json(
      { error: "unauthenticated", code: "unauthenticated" },
      { status: 401 },
    );
  }
  const user = ctx.user;
  if (!user.totp_enabled || !user.totp_secret) {
    return NextResponse.json(
      {
        error: "mfa_not_enrolled",
        code: "mfa_not_enrolled",
        detail:
          "enroll a TOTP authenticator in /settings/security before using step-up",
      },
      { status: 401 },
    );
  }
  const sid = ctx.payload.sid;
  if (!sid) {
    return NextResponse.json(
      {
        error: "no_session_record",
        code: "no_session_record",
        detail: "sign out and sign back in to enable per-session MFA tracking",
      },
      { status: 401 },
    );
  }

  let parsed: { code?: string; recovery?: string };
  try {
    parsed = Body.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json(
      { error: "bad_request", code: "bad_request", detail: "provide code or recovery" },
      { status: 400 },
    );
  }
  if (!parsed.code && !parsed.recovery) {
    return NextResponse.json(
      { error: "bad_request", code: "bad_request", detail: "provide code or recovery" },
      { status: 400 },
    );
  }

  const ip = clientIpFromRequest(req);
  const emailLock = await checkLockout("totp_verify", user.email);
  if (!emailLock.ok) {
    const retrySec = Math.max(1, Math.ceil(emailLock.retry_after_ms / 1000));
    await recordAuthEvent({
      verb: "mfa",
      method: parsed.recovery ? "recovery_code" : "totp",
      outcome: "denied",
      reason: "step_up_locked_email",
      email: user.email,
      userId: user.id,
      request: req,
    });
    return NextResponse.json(
      {
        error: "locked_out",
        code: "locked_out",
        detail: "too many wrong codes, try again later",
        retry_after_seconds: retrySec,
      },
      { status: 429, headers: { "Retry-After": String(retrySec) } },
    );
  }
  const ipLock = await checkLockout("totp_verify", ip);
  if (!ipLock.ok) {
    const retrySec = Math.max(1, Math.ceil(ipLock.retry_after_ms / 1000));
    return NextResponse.json(
      {
        error: "locked_out",
        code: "locked_out",
        detail: "too many wrong codes from this network",
        retry_after_seconds: retrySec,
      },
      { status: 429, headers: { "Retry-After": String(retrySec) } },
    );
  }

  let ok = false;
  let usedRecovery = false;
  if (parsed.code && verifyTotp(user.totp_secret, parsed.code)) {
    ok = true;
  } else if (parsed.recovery) {
    ok = await consumeRecoveryCode(user.id, parsed.recovery);
    usedRecovery = ok;
  }
  if (!ok) {
    await recordFailure("totp_verify", user.email);
    await recordFailure("totp_verify", ip);
    await recordAuthEvent({
      verb: "mfa",
      method: parsed.recovery ? "recovery_code" : "totp",
      outcome: "failure",
      reason: parsed.recovery ? "invalid_recovery_code" : "invalid_totp_code",
      email: user.email,
      userId: user.id,
      metadata: { context: "step_up" },
      request: req,
    });
    await recordAudit({
      action: "auth.step_up",
      target: sid,
      outcome: "failure",
      actor: { user_id: user.id, email: user.email },
      metadata: { method: usedRecovery ? "recovery_code" : "totp" },
      request: req,
    });
    return NextResponse.json(
      {
        error: "invalid_code",
        code: "invalid_code",
        detail: "that code is not valid",
      },
      { status: 401 },
    );
  }
  await clearBucket("totp_verify", user.email);
  const now = Date.now();
  const updated = await markSessionMfa(sid, now);
  if (!updated) {
    return NextResponse.json(
      {
        error: "no_session_record",
        code: "no_session_record",
        detail: "session not found; sign in again",
      },
      { status: 401 },
    );
  }
  const fresh = (await getUserById(user.id)) ?? user;
  await recordAuthEvent({
    verb: "mfa",
    method: usedRecovery ? "recovery_code" : "totp",
    outcome: "success",
    email: fresh.email,
    userId: fresh.id,
    metadata: { context: "step_up", used_recovery_code: usedRecovery },
    request: req,
  });
  await recordAudit({
    action: "auth.step_up",
    target: sid,
    outcome: "success",
    actor: { user_id: fresh.id, email: fresh.email },
    metadata: {
      method: usedRecovery ? "recovery_code" : "totp",
      max_age_seconds: Math.floor(STEP_UP_MAX_AGE_MS / 1000),
    },
    request: req,
  });
  return NextResponse.json({
    ok: true,
    last_mfa_at: now,
    max_age_seconds: Math.floor(STEP_UP_MAX_AGE_MS / 1000),
    used_recovery_code: usedRecovery,
    recovery_codes_remaining: fresh.recovery_code_hashes?.length ?? 0,
  });
}

export async function GET() {
  // Lightweight probe for the UI to show "step-up will be required" hints.
  return NextResponse.json({
    max_age_seconds: Math.floor(STEP_UP_MAX_AGE_MS / 1000),
  });
}
