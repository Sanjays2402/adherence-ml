/**
 * Begin TOTP enrollment. Generates a fresh secret, stages it on the user
 * (overwriting any half-finished prior attempt), and returns the otpauth://
 * URI for QR rendering plus the base32 secret for manual entry.
 *
 *   POST /api/auth/2fa/setup -> { secret, otpauth_uri }
 *
 * The secret only becomes active once the user posts a valid code to
 * /api/auth/2fa/enable.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { setPendingTotpSecret } from "@/lib/users-store";
import {
  formatSecretForDisplay,
  generateTotpSecret,
  otpauthUri,
} from "@/lib/totp";
import { recordAuthEvent } from "@/lib/auth-audit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in first." } },
      { status: 401 },
    );
  }
  if (ctx.user.totp_enabled) {
    return NextResponse.json(
      {
        error: {
          code: "already_enabled",
          message: "Disable 2FA before generating a new secret.",
        },
      },
      { status: 409 },
    );
  }
  const { base32 } = generateTotpSecret();
  await setPendingTotpSecret(ctx.user.id, base32);
  const uri = otpauthUri({
    secretBase32: base32,
    accountName: ctx.user.email,
    issuer: "adherence.ml",
  });
  await recordAuthEvent({
    verb: "mfa_setup",
    method: "totp",
    outcome: "success",
    email: ctx.user.email,
    userId: ctx.user.id,
    request: req,
  });
  return NextResponse.json({
    secret: base32,
    secret_pretty: formatSecretForDisplay(base32),
    otpauth_uri: uri,
  });
}
