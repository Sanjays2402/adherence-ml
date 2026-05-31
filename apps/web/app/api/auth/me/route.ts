import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json({ user: null }, { status: 200 });
  }
  return NextResponse.json({
    user: {
      id: ctx.user.id,
      email: ctx.user.email,
      created_at: ctx.user.created_at,
      last_login_at: ctx.user.last_login_at,
    },
  });
}
