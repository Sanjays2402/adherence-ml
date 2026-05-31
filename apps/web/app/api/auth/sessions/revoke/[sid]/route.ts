/**
 * Revoke one session by sid, scoped to the signed-in user.
 *
 * DELETE /api/auth/sessions/revoke/:sid
 *
 * Refuses to revoke the cookie that issued the request (UX guard: that is
 * a sign-out, not a session revoke). Cross-user revocation is impossible
 * because revokeSession() filters by user_id at the store layer.
 *
 * Every revoke is written to the tamper-evident dashboard audit log.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  getSessionRecord,
  revokeSession,
} from "@/lib/sessions-store";
import { recordAudit } from "@/lib/dashboard-audit";
import { isDryRun, withDryRunHeaders, dryRunBody } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ sid: string }> },
) {
  const sess = await getSession(req);
  if (!sess) {
    return NextResponse.json({ detail: "unauthenticated" }, { status: 401 });
  }
  const { sid } = await params;
  if (!sid || typeof sid !== "string") {
    return NextResponse.json({ detail: "sid required" }, { status: 400 });
  }
  if (sess.payload.sid && sid === sess.payload.sid) {
    return NextResponse.json(
      { detail: "cannot revoke current session; use POST /api/auth/logout" },
      { status: 400 },
    );
  }

  // Pre-fetch to give the audit log a meaningful before-image (label/ip/ua)
  // and to distinguish 404 from cross-user attempts.
  const rec = await getSessionRecord(sid);
  const ownedByCaller = rec ? rec.user_id === sess.user.id : false;

  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "session",
          id: sid,
          summary: ownedByCaller
            ? `revoke session ${sid} (label=${rec?.label ?? "?"}, ip=${rec?.ip ?? "?"})`
            : `no-op: session ${sid} not found or not owned by caller`,
          before:
            ownedByCaller && rec
              ? {
                  sid: rec.sid,
                  label: rec.label,
                  ip: rec.ip,
                  user_agent: rec.user_agent,
                  last_seen_at: rec.last_seen_at,
                }
              : undefined,
        }),
      ),
    );
  }

  const flipped = await revokeSession(sid, sess.user.id);
  if (!flipped) {
    await recordAudit({
      action: "session.revoke",
      target: `session:${sid}`,
      outcome: "denied",
      actor: { user_id: sess.user.id, email: sess.user.email },
      metadata: {
        reason: ownedByCaller ? "already_revoked_or_expired" : "not_owned_or_unknown",
      },
      request: req,
    });
    return NextResponse.json(
      { detail: "session not found" },
      { status: 404 },
    );
  }

  await recordAudit({
    action: "session.revoke",
    target: `session:${sid}`,
    outcome: "success",
    actor: { user_id: sess.user.id, email: sess.user.email },
    metadata: {
      label: rec?.label ?? null,
      ip: rec?.ip ?? null,
      user_agent: rec?.user_agent ?? null,
    },
    request: req,
  });
  return NextResponse.json({ ok: true, sid, revoked: true });
}
