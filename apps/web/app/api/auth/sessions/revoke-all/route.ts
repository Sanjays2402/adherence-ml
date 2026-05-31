import { NextRequest, NextResponse } from "next/server";
import {
  getSession,
  buildSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  requestContextFromHeaders,
} from "@/lib/session";
import { bumpSessionGen, getUserById } from "@/lib/users-store";
import { revokeAllForUser } from "@/lib/sessions-store";
import { recordAudit } from "@/lib/dashboard-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Force-revoke every outstanding session for the current user, then re-mint
 * a fresh cookie for the caller so the active browser stays signed in.
 *
 * Body: { keep_current?: boolean } (default true). When `keep_current` is
 * false the response clears the session cookie and the user is signed out
 * of this browser too.
 */
export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json(
      { detail: "unauthenticated" },
      { status: 401 },
    );
  }

  let keepCurrent = true;
  try {
    const body = (await req.json()) as { keep_current?: unknown } | null;
    if (body && typeof body === "object" && body.keep_current === false) {
      keepCurrent = false;
    }
  } catch {
    /* empty body is fine */
  }

  const bumped = await bumpSessionGen(sess.user.id);
  if (!bumped) {
    return NextResponse.json(
      { detail: "user not found" },
      { status: 404 },
    );
  }
  // Also flip every per-session record so cookies carrying a sid stop
  // verifying on their next request (legacy cookies fall back to the gen).
  const revokedCount = await revokeAllForUser(
    sess.user.id,
    keepCurrent ? sess.payload.sid ?? null : null,
  );

  await recordAudit({
    action: "session.revoke_all",
    target: `user:${sess.user.id}`,
    outcome: "success",
    actor: { user_id: sess.user.id, email: sess.user.email },
    metadata: {
      sessions_revoked: revokedCount,
      kept_current: keepCurrent,
      current_generation: bumped.session_gen,
    },
    request: req,
  });

  const res = NextResponse.json({
    ok: true,
    sessions_revoked_at: bumped.sessions_revoked_at,
    current_generation: bumped.session_gen,
    sessions_revoked: revokedCount,
    kept_current: keepCurrent,
  });

  if (keepCurrent) {
    // Re-read so buildSession sees the bumped generation.
    const fresh = await getUserById(sess.user.id);
    if (fresh) {
      const { cookie, expires } = await buildSession(
        fresh,
        requestContextFromHeaders(req.headers, "revoke-all"),
      );
      res.cookies.set(SESSION_COOKIE, cookie, sessionCookieOptions(expires));
    }
  } else {
    res.cookies.set(SESSION_COOKIE, "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: new Date(0),
    });
  }
  return res;
}
