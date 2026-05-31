import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { markAllRead } from "@/lib/notifications-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const count = await markAllRead(session.user.id);
  return NextResponse.json({ ok: true, marked: count });
}
