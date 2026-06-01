/**
 * GDPR / CCPA right-to-erasure endpoint for the signed-in user.
 *
 *   GET    /api/auth/account            preview what would be deleted
 *   DELETE /api/auth/account            body: { confirm: "DELETE MY ACCOUNT" }
 *
 * Hard-deletes the user record, every workspace membership, any workspace
 * they alone owned, every magic-link token issued to their email, and
 * tombstones every note they authored. Refuses if the user is the sole
 * owner of a workspace with other members; the caller must either transfer
 * ownership or remove those members first.
 *
 * Always lands in the tamper-evident dashboard audit log, including denied
 * attempts. The session cookie is cleared on success so the now-deleted
 * cookie cannot be replayed.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession, SESSION_COOKIE } from "@/lib/session";
import { requireRecentMfa } from "@/lib/step-up";
import { recordAudit } from "@/lib/dashboard-audit";
import { isDryRun, withDryRunHeaders, dryRunBody } from "@/lib/dry-run";
import {
  previewAccountErasure,
  eraseAccount,
  AccountErasureBlocked,
  CONFIRM_PHRASE,
} from "@/lib/account-erase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json(
      { detail: "auth required" },
      { status: 401 },
    );
  }
  const preview = await previewAccountErasure(sess.user.id);
  if (!preview) {
    return NextResponse.json({ detail: "user not found" }, { status: 404 });
  }
  return NextResponse.json(preview);
}

const DeleteBody = z.object({
  confirm: z.string(),
});

export async function DELETE(req: NextRequest) {
  const sess = await getSession(req);
  if (!sess) {
    return NextResponse.json(
      { detail: "auth required" },
      { status: 401 },
    );
  }

  // Step-up MFA: erasing an account is irreversible and must require a
  // fresh second factor when the user has one (or when policy mandates).
  // Dry-run previews are exempt so the UI can render the impact upfront.
  if (!isDryRun(req)) {
    const step = await requireRecentMfa(req, sess);
    if (!step.ok) {
      await recordAudit({
        action: "account.delete",
        target: `user:${sess.user.id}`,
        outcome: "denied",
        actor: { user_id: sess.user.id, email: sess.user.email },
        metadata: {
          reason: "mfa_step_up_required",
          step_up_reason: step.decision.reason ?? null,
        },
        request: req,
      });
      return step.response;
    }
  }

  if (isDryRun(req)) {
    const preview = await previewAccountErasure(sess.user.id);
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "user_account",
          id: sess.user.id,
          summary: `permanently erase account ${sess.user.email} and remove from ${preview?.memberships.length ?? 0} workspace(s); ${preview?.blockers.length ?? 0} blocker(s)`,
          before: { email: sess.user.email, plan: preview },
        }),
      ),
    );
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    /* fallthrough -> validation fails */
  }
  const parsed = DeleteBody.safeParse(body);
  if (!parsed.success || parsed.data.confirm !== CONFIRM_PHRASE) {
    await recordAudit({
      action: "account.delete",
      target: `user:${sess.user.id}`,
      outcome: "denied",
      actor: { user_id: sess.user.id, email: sess.user.email },
      metadata: { reason: "bad_confirm" },
      request: req,
    });
    return NextResponse.json(
      {
        detail: `confirm phrase required; POST { "confirm": "${CONFIRM_PHRASE}" }`,
        confirm_phrase: CONFIRM_PHRASE,
      },
      { status: 400 },
    );
  }

  try {
    const result = await eraseAccount(sess.user);
    await recordAudit({
      action: "account.delete",
      target: `user:${result.user_id}`,
      outcome: "success",
      // actor is intentionally null on the immutable record so the chain
      // does not retain PII for the just-erased user; we keep a hashed
      // marker in metadata so admins can still attribute the row.
      actor: null,
      metadata: {
        erased_user_id: result.user_id,
        workspaces_deleted: result.workspaces.workspaces_deleted.length,
        memberships_removed: result.workspaces.memberships_removed,
        notes_tombstoned: result.notes_tombstoned,
        invites_revoked: result.workspaces.invites_revoked,
        sessions_revoked_at: result.sessions_revoked_at,
      },
      request: req,
    });
    const res = NextResponse.json({ ok: true, ...result });
    res.cookies.set(SESSION_COOKIE, "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: new Date(0),
    });
    return res;
  } catch (err) {
    if (err instanceof AccountErasureBlocked) {
      await recordAudit({
        action: "account.delete",
        target: `user:${sess.user.id}`,
        outcome: "denied",
        actor: { user_id: sess.user.id, email: sess.user.email },
        metadata: {
          reason: "sole_owner_of_shared_workspace",
          blockers: err.blockers,
        },
        request: req,
      });
      return NextResponse.json(
        {
          detail:
            "you are the sole owner of one or more shared workspaces; transfer ownership before deleting your account",
          blockers: err.blockers,
        },
        { status: 409 },
      );
    }
    await recordAudit({
      action: "account.delete",
      target: `user:${sess.user.id}`,
      outcome: "failure",
      actor: { user_id: sess.user.id, email: sess.user.email },
      metadata: { error: String(err) },
      request: req,
    });
    return NextResponse.json(
      { detail: "internal error" },
      { status: 500 },
    );
  }
}
