import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  getWorkspaceForUser,
  listInvites,
  removeMember,
  renameWorkspace,
  deleteWorkspace,
} from "@/lib/workspaces-store";

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
  if (!target) {
    // No user_id means: delete the whole workspace (owner only).
    const ok = await deleteWorkspace(id, ctx.user.id);
    if (!ok) return NextResponse.json({ detail: "forbidden" }, { status: 403 });
    return NextResponse.json({ ok: true, deleted: "workspace" });
  }
  const ok = await removeMember(id, ctx.user.id, target);
  if (!ok) return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name.trim()) {
    return NextResponse.json({ detail: "name required" }, { status: 400 });
  }
  const ws = await renameWorkspace(id, ctx.user.id, name);
  if (!ws) return NextResponse.json({ detail: "forbidden or not found" }, { status: 403 });
  return NextResponse.json({ workspace: ws });
}
