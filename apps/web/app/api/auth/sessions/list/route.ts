/**
 * List active sessions for the signed-in user.
 *
 * GET /api/auth/sessions/list
 *
 * Returns one entry per non-revoked, non-expired session record. The entry
 * for the cookie that issued the request is marked `current: true` so the
 * UI can disable the revoke button on that row (revoking your own current
 * session is "sign out", which has its own endpoint).
 */
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listSessionsForUser } from "@/lib/sessions-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ detail: "unauthenticated" }, { status: 401 });
  }
  const rows = await listSessionsForUser(sess.user.id);
  const currentSid = sess.payload.sid ?? null;
  return NextResponse.json({
    current_sid: currentSid,
    sessions: rows.map((r) => ({
      sid: r.sid,
      label: r.label,
      ip: r.ip,
      user_agent: r.user_agent,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      expires_at: r.expires_at,
      current: currentSid !== null && r.sid === currentSid,
    })),
  });
}
