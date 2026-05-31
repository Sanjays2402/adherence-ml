import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  createInvite,
  getWorkspaceForUser,
  revokeInvite,
  ROLES,
} from "@/lib/workspaces-store";

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
  let body: unknown;
  try {
    body = await req.json();
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
    return NextResponse.json({
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
  const ok = await revokeInvite(id, inviteId);
  if (!ok) return NextResponse.json({ detail: "not found or already used" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
