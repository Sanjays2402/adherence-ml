import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { deleteNotification } from "@/lib/notifications-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });

  const ok = await deleteNotification(session.user.id, id);
  if (!ok) {
    return NextResponse.json(
      { error: "not_found", detail: "no such notification or it is a broadcast" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
