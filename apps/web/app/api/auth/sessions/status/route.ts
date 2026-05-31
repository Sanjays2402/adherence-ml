import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { currentSessionGen } from "@/lib/users-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only view of the current session and the user's revocation state.
 * Used by the security settings UI to render "last force-logout" timestamps.
 */
export async function GET() {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json(
      { detail: "unauthenticated" },
      { status: 401 },
    );
  }
  const { user, payload } = sess;
  const cookieGen = typeof payload.gen === "number" ? payload.gen : 1;
  return NextResponse.json({
    user_id: user.id,
    email: user.email,
    issued_at: payload.iat,
    expires_at: payload.exp,
    cookie_generation: cookieGen,
    current_generation: currentSessionGen(user),
    sessions_revoked_at: user.sessions_revoked_at ?? null,
  });
}
