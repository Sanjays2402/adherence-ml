import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { acceptInvite, previewInvite } from "@/lib/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ detail: "token required" }, { status: 400 });
  const preview = await previewInvite(token);
  if (!preview) return NextResponse.json({ detail: "invalid or expired" }, { status: 404 });
  return NextResponse.json({
    workspace: { id: preview.workspace.id, name: preview.workspace.name },
    email: preview.invite.email,
    role: preview.invite.role,
    expires_at: preview.invite.expires_at,
  });
}

const Schema = z.object({ token: z.string().min(8).max(200) });

export async function POST(req: NextRequest) {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json({ detail: "sign in required" }, { status: 401 });
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
  const result = await acceptInvite(parsed.data.token, ctx.user.id, ctx.user.email);
  if (!result) {
    return NextResponse.json(
      { detail: "invite is invalid, expired, or for a different email" },
      { status: 400 },
    );
  }
  return NextResponse.json({
    workspace: result.workspace,
    role: result.role,
  });
}
