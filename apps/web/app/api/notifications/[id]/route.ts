import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { deleteNotification, listForUser } from "@/lib/notifications-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

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

  if (isDryRun(req)) {
    const items = await listForUser(session.user.id, { limit: 500 });
    const found = items.find((n) => n.id === id && n.user_id !== null);
    if (!found) {
      return NextResponse.json(
        { error: "not_found", detail: "no such notification or it is a broadcast" },
        { status: 404 },
      );
    }
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "notification",
          id,
          summary: `dismiss notification '${found.title}' for user ${session.user.id}`,
          before: {
            id: found.id,
            kind: found.kind,
            title: found.title,
            created_at: found.created_at,
          },
        }),
      ),
    );
  }

  const ok = await deleteNotification(session.user.id, id);
  if (!ok) {
    return NextResponse.json(
      { error: "not_found", detail: "no such notification or it is a broadcast" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
