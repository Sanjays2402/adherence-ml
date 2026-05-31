/**
 * Disable TOTP. Requires a fresh authenticator code or a recovery code,
 * to prevent a stolen session cookie from silently turning off 2FA.
 *
 *   POST /api/auth/2fa/disable  { code?: "123456", recovery?: "abcd-efgh" }
 *     -> { ok: true }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { consumeRecoveryCode, disableTotp } from "@/lib/users-store";
import { verifyTotp } from "@/lib/totp";
import { recordAuthEvent } from "@/lib/auth-audit";

export const runtime = "nodejs";

const Body = z.object({
  code: z.string().trim().regex(/^\d{6}$/u).optional(),
  recovery: z.string().trim().min(4).max(64).optional(),
});

export async function POST(req: NextRequest) {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in first." } },
      { status: 401 },
    );
  }
  if (!ctx.user.totp_enabled || !ctx.user.totp_secret) {
    return NextResponse.json(
      { error: { code: "not_enabled", message: "2FA is not enabled on this account." } },
      { status: 409 },
    );
  }
  let parsed: { code?: string; recovery?: string };
  try {
    parsed = Body.parse(await req.json().catch(() => ({})));
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Body must be JSON with code or recovery." } },
      { status: 400 },
    );
  }
  let ok = false;
  if (parsed.code && verifyTotp(ctx.user.totp_secret, parsed.code)) ok = true;
  else if (parsed.recovery && (await consumeRecoveryCode(ctx.user.id, parsed.recovery))) ok = true;
  if (!ok) {
    await recordAuthEvent({
      verb: "mfa_disable",
      method: parsed.recovery ? "recovery_code" : "totp",
      outcome: "failure",
      reason: "invalid_code",
      email: ctx.user.email,
      userId: ctx.user.id,
      request: req,
    });
    return NextResponse.json(
      { error: { code: "invalid_code", message: "Code or recovery key did not match." } },
      { status: 400 },
    );
  }
  await disableTotp(ctx.user.id);
  await recordAuthEvent({
    verb: "mfa_disable",
    method: "totp",
    outcome: "success",
    email: ctx.user.email,
    userId: ctx.user.id,
    request: req,
  });
  return NextResponse.json({ ok: true });
}
