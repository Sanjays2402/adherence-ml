/**
 * Returns the user's 2FA status. Authenticated only.
 *
 *   GET /api/auth/2fa/status -> { enabled, recovery_codes_remaining, updated_at }
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(_req: NextRequest) {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in first." } },
      { status: 401 },
    );
  }
  const u = ctx.user;
  return NextResponse.json({
    enabled: Boolean(u.totp_enabled && u.totp_secret),
    setup_in_progress: Boolean(u.totp_secret && !u.totp_enabled),
    recovery_codes_remaining: u.recovery_code_hashes?.length ?? 0,
    updated_at: u.totp_updated_at ?? null,
  });
}
