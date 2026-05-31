/**
 * Second factor of the login flow. Reads the short-lived mfa_pending cookie
 * set by /api/auth/verify or /api/auth/github/callback, accepts a TOTP code
 * (or a single-use recovery code), and on success upgrades the request to a
 * real signed session cookie.
 *
 *   POST /api/auth/2fa/verify  { code?: "123456", recovery?: "abcd-efgh" }
 *     -> { ok: true, next: "/" }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  MFA_PENDING_COOKIE,
  SESSION_COOKIE,
  buildSession,
  requestContextFromHeaders,
  getPendingMfa,
} from "@/lib/session";
import { consumeRecoveryCode, getUserById } from "@/lib/users-store";
import { verifyTotp } from "@/lib/totp";
import { recordAuthEvent } from "@/lib/auth-audit";
import {
  checkLockout,
  clearBucket,
  clientIpFromRequest,
  recordFailure,
} from "@/lib/login-throttle";

export const runtime = "nodejs";

const Body = z.object({
  code: z.string().trim().regex(/^\d{6}$/u).optional(),
  recovery: z.string().trim().min(4).max(64).optional(),
});

export async function POST(req: NextRequest) {
  const pending = await getPendingMfa(req);
  if (!pending) {
    return NextResponse.json(
      {
        error: {
          code: "no_pending_mfa",
          message: "Sign-in challenge expired. Request a new magic link.",
        },
      },
      { status: 401 },
    );
  }
  let parsed: { code?: string; recovery?: string };
  try {
    parsed = Body.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Body must include code or recovery." } },
      { status: 400 },
    );
  }
  if (!parsed.code && !parsed.recovery) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Provide code or recovery." } },
      { status: 400 },
    );
  }
  const user = pending.user;

  // Pre-check brute-force lockout for both the user's email and the
  // client IP. Same lockout response shape as the magic-link route.
  const ip = clientIpFromRequest(req);
  const emailLock = await checkLockout("totp_verify", user.email);
  if (!emailLock.ok) {
    const retrySec = Math.max(1, Math.ceil(emailLock.retry_after_ms / 1000));
    await recordAuthEvent({
      verb: "mfa",
      method: parsed.recovery ? "recovery_code" : "totp",
      outcome: "denied",
      reason: "locked_out_email",
      email: user.email,
      userId: user.id,
      request: req,
    });
    return NextResponse.json(
      {
        error: {
          code: "locked_out",
          message:
            "Too many wrong codes. Try again later or use a recovery code after the cool-down.",
          retry_after_seconds: retrySec,
        },
      },
      { status: 429, headers: { "Retry-After": String(retrySec) } },
    );
  }
  const ipLock = await checkLockout("totp_verify", ip);
  if (!ipLock.ok) {
    const retrySec = Math.max(1, Math.ceil(ipLock.retry_after_ms / 1000));
    await recordAuthEvent({
      verb: "mfa",
      method: parsed.recovery ? "recovery_code" : "totp",
      outcome: "denied",
      reason: "locked_out_ip",
      email: user.email,
      userId: user.id,
      request: req,
    });
    return NextResponse.json(
      {
        error: {
          code: "locked_out",
          message: "Too many wrong codes from this network. Try again later.",
          retry_after_seconds: retrySec,
        },
      },
      { status: 429, headers: { "Retry-After": String(retrySec) } },
    );
  }

  let ok = false;
  let usedRecovery = false;
  if (parsed.code && user.totp_secret && verifyTotp(user.totp_secret, parsed.code)) {
    ok = true;
  } else if (parsed.recovery) {
    ok = await consumeRecoveryCode(user.id, parsed.recovery);
    usedRecovery = ok;
  }
  if (!ok) {
    // Count both axes so a single attacker can't dodge per-email throttling
    // by rotating IPs nor dodge per-IP throttling by rotating emails.
    await recordFailure("totp_verify", user.email);
    await recordFailure("totp_verify", ip);
    await recordAuthEvent({
      verb: "mfa",
      method: parsed.recovery ? "recovery_code" : "totp",
      outcome: "failure",
      reason: parsed.recovery ? "invalid_recovery_code" : "invalid_totp_code",
      email: user.email,
      userId: user.id,
      request: req,
    });
    return NextResponse.json(
      {
        error: {
          code: "invalid_code",
          message: "That code is not valid. Try again or use a recovery code.",
        },
      },
      { status: 401 },
    );
  }
  // Re-read user to get an authoritative recovery_code_hashes count after consumption.
  const fresh = (await getUserById(user.id)) ?? user;
  // Successful 2FA clears the email bucket so the user is not penalised
  // for prior typos. We leave the IP bucket alone since multiple users
  // may share an egress IP and we only want to forgive on real success.
  await clearBucket("totp_verify", user.email);
  const { cookie, expires } = await buildSession(
    fresh,
    requestContextFromHeaders(req.headers, "2fa"),
  );
  const nextDest =
    pending.payload.next && pending.payload.next.startsWith("/") && !pending.payload.next.startsWith("//")
      ? pending.payload.next
      : "/";
  const res = NextResponse.json({
    ok: true,
    next: nextDest,
    used_recovery_code: usedRecovery,
    recovery_codes_remaining: fresh.recovery_code_hashes?.length ?? 0,
  });
  res.cookies.set(SESSION_COOKIE, cookie, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
  });
  // Burn the pending cookie.
  res.cookies.set(MFA_PENDING_COOKIE, "", { path: "/", maxAge: 0 });
  await recordAuthEvent({
    verb: "mfa",
    method: usedRecovery ? "recovery_code" : "totp",
    outcome: "success",
    email: fresh.email,
    userId: fresh.id,
    metadata: { used_recovery_code: usedRecovery },
    request: req,
  });
  return res;
}

export async function GET(req: NextRequest) {
  // Used by the /verify-2fa client to find out whose challenge is in flight.
  const pending = await getPendingMfa(req);
  if (!pending) {
    return NextResponse.json(
      { pending: false },
      { status: 200 },
    );
  }
  return NextResponse.json({
    pending: true,
    email: pending.user.email,
    expires_at: pending.payload.exp,
    next: pending.payload.next ?? "/",
  });
}
