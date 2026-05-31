import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { updateMemberRole, isRole } from "@/lib/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id, userId } = await params;

  let body: { role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const role = body?.role;
  if (!isRole(role)) {
    return NextResponse.json({ detail: "invalid role" }, { status: 400 });
  }

  const result = await updateMemberRole(id, ctx.user.id, userId, role);
  if (!result.ok) {
    const status =
      result.reason === "forbidden"
        ? 403
        : result.reason === "not_found"
          ? 404
          : 400;
    return NextResponse.json({ detail: result.reason }, { status });
  }
  return NextResponse.json({ ok: true, member: result.member });
}
