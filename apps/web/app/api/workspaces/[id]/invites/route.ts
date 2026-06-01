import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  createInvite,
  getWorkspaceForUser,
  listInvites,
  revokeInvite,
  ROLES,
} from "@/lib/workspaces-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { emit } from "@/lib/webhook-dispatch";
import { beginIdempotency, finishIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({
  email: z.string().email(),
  role: z.enum(ROLES as [string, ...string[]]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  if (ws.role !== "owner" && ws.role !== "editor") {
    return NextResponse.json({ detail: "owner or editor only" }, { status: 403 });
  }
  // Read raw body once so the idempotency hash matches exactly what the
  // client sent (whitespace and key order included).
  const rawBody = await req.text();
  const idem = await beginIdempotency(req, id, rawBody);
  if (idem.kind === "replay" || idem.kind === "conflict" || idem.kind === "invalid") {
    return idem.response;
  }
  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const { token, invite } = await createInvite(
      id,
      ctx.user.id,
      parsed.data.email,
      parsed.data.role as "owner" | "editor" | "viewer",
    );
    const origin = req.nextUrl.origin;
    void emit("member.invited", {
      workspace_id: id,
      invitee_email: invite.email,
      role: invite.role,
      invited_by: ctx.user.email ?? ctx.user.id,
      invited_at: new Date().toISOString(),
      expires_at: new Date(invite.expires_at).toISOString(),
    });
    const response = NextResponse.json({
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expires_at: invite.expires_at,
      },
      // token is returned exactly once for the inviter to copy / share
      token,
      accept_url: `${origin}/invite/${token}`,
    });
    return idem.kind === "live" ? await finishIdempotency(idem, response) : response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed";
    return NextResponse.json({ detail: msg }, { status: 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  if (ws.role !== "owner") {
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  const url = new URL(req.url);
  const inviteId = url.searchParams.get("invite_id");
  if (!inviteId) return NextResponse.json({ detail: "invite_id required" }, { status: 400 });

  if (isDryRun(req)) {
    const invites = await listInvites(id);
    const inv = invites.find((i) => i.id === inviteId);
    if (!inv || inv.accepted_at || inv.revoked_at) {
      return NextResponse.json({ detail: "not found or already used" }, { status: 404 });
    }
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_invite",
          id: inviteId,
          summary: `revoke pending invite for ${inv.email} (role ${inv.role}); their accept link will stop working`,
          before: {
            id: inv.id,
            email: inv.email,
            role: inv.role,
            expires_at: inv.expires_at,
          },
        }),
      ),
    );
  }

  const ok = await revokeInvite(id, inviteId);
  if (!ok) return NextResponse.json({ detail: "not found or already used" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
