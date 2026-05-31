/**
 * Confirm TOTP enrollment. Caller submits the current 6-digit code from their
 * authenticator app; if it matches the pending secret we flip totp_enabled
 * to true and return one-time recovery codes (plaintext, displayed once).
 *
 *   POST /api/auth/2fa/enable  { code: "123456" }
 *     -> { ok: true, recovery_codes: [...] }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { enableTotp, generateRecoveryCodes } from "@/lib/users-store";
import { verifyTotp } from "@/lib/totp";
import { recordAuthEvent } from "@/lib/auth-audit";

export const runtime = "nodejs";

const Body = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/u, "Code must be 6 digits."),
});

export async function POST(req: NextRequest) {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in first." } },
      { status: 401 },
    );
  }
  const secret = ctx.user.totp_secret;
  if (!secret) {
    return NextResponse.json(
      {
        error: {
          code: "no_pending_secret",
          message: "Call /api/auth/2fa/setup first.",
        },
      },
      { status: 409 },
    );
  }
  let parsed: { code: string };
  try {
    parsed = Body.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message ?? "Invalid body." : "Invalid body.";
    return NextResponse.json(
      { error: { code: "bad_request", message: msg } },
      { status: 400 },
    );
  }
  if (!verifyTotp(secret, parsed.code)) {
    await recordAuthEvent({
      verb: "mfa_enable",
      method: "totp",
      outcome: "failure",
      reason: "invalid_code",
      email: ctx.user.email,
      userId: ctx.user.id,
      request: req,
    });
    return NextResponse.json(
      {
        error: {
          code: "invalid_code",
          message: "That code is not valid. Check your authenticator clock and try again.",
        },
      },
      { status: 400 },
    );
  }
  const recovery = generateRecoveryCodes(10);
  const updated = await enableTotp(ctx.user.id, recovery);
  if (!updated) {
    return NextResponse.json(
      { error: { code: "not_found", message: "User vanished." } },
      { status: 404 },
    );
  }
  await recordAuthEvent({
    verb: "mfa_enable",
    method: "totp",
    outcome: "success",
    email: ctx.user.email,
    userId: ctx.user.id,
    request: req,
  });
  return NextResponse.json({ ok: true, recovery_codes: recovery });
}
