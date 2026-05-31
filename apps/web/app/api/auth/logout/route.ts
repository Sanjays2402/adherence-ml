import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";
import { getSession } from "@/lib/session";
import { recordAuthEvent } from "@/lib/auth-audit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const ctx = await getSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(0),
  });
  await recordAuthEvent({
    verb: "logout",
    method: "session",
    outcome: "success",
    email: ctx?.user.email ?? null,
    userId: ctx?.user.id ?? null,
    request: req,
  });
  return res;
}
