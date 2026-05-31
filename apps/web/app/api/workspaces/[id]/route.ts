import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getWorkspaceForUser, listInvites, removeMember } from "@/lib/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  const invites = await listInvites(id);
  return NextResponse.json({
    workspace: ws.workspace,
    role: ws.role,
    members: ws.members,
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      created_at: i.created_at,
      expires_at: i.expires_at,
      accepted_at: i.accepted_at,
      revoked_at: i.revoked_at,
    })),
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const url = new URL(req.url);
  const target = url.searchParams.get("user_id");
  if (!target) return NextResponse.json({ detail: "user_id required" }, { status: 400 });
  const ok = await removeMember(id, ctx.user.id, target);
  if (!ok) return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true });
}
