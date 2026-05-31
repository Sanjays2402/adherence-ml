import { NextResponse, type NextRequest } from "next/server";
import { consumeMagicToken, hasTotpEnabled } from "@/lib/users-store";
import {
  MFA_PENDING_COOKIE,
  SESSION_COOKIE,
  buildMfaPending,
  buildSession,
} from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.redirect(new URL("/login?error=missing_token", req.url));
  }
  const user = await consumeMagicToken(token);
  if (!user) {
    return NextResponse.redirect(new URL("/login?error=invalid_or_expired", req.url));
  }
  const { cookie, expires } = buildSession(user);
  const dest = req.nextUrl.searchParams.get("next") || "/";
  // Only allow same-origin relative redirects; ignore anything fancy.
  const safeDest = dest.startsWith("/") && !dest.startsWith("//") ? dest : "/";
  if (hasTotpEnabled(user)) {
    const { cookie: pendCookie, expires: pendExp } = buildMfaPending(user, safeDest);
    const res = NextResponse.redirect(
      new URL(`/verify-2fa?next=${encodeURIComponent(safeDest)}`, req.url),
    );
    res.cookies.set(MFA_PENDING_COOKIE, pendCookie, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: pendExp,
    });
    return res;
  }
  const res = NextResponse.redirect(new URL(safeDest, req.url));
  res.cookies.set(SESSION_COOKIE, cookie, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
  });
  return res;
}

export async function POST(req: NextRequest) {
  // JSON variant used by the /verify client page so it can surface errors
  // inline instead of bouncing through redirect chains.
  let body: { token?: string; next?: string };
  try {
    body = (await req.json()) as { token?: string; next?: string };
  } catch {
    return NextResponse.json(
      { error: { code: "bad_json", message: "Request body must be JSON." } },
      { status: 400 },
    );
  }
  const token = body.token;
  if (!token) {
    return NextResponse.json(
      { error: { code: "missing_token", message: "Token is required." } },
      { status: 400 },
    );
  }
  const user = await consumeMagicToken(token);
  if (!user) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_or_expired",
          message: "This link is invalid or has expired. Request a new one.",
        },
      },
      { status: 401 },
    );
  }
  const { cookie, expires } = buildSession(user);
  const dest = body.next || "/";
  const safeDest = dest.startsWith("/") && !dest.startsWith("//") ? dest : "/";
  if (hasTotpEnabled(user)) {
    const { cookie: pendCookie, expires: pendExp } = buildMfaPending(user, safeDest);
    const res = NextResponse.json({
      ok: true,
      mfa_required: true,
      next: `/verify-2fa?next=${encodeURIComponent(safeDest)}`,
    });
    res.cookies.set(MFA_PENDING_COOKIE, pendCookie, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: pendExp,
    });
    return res;
  }
  const res = NextResponse.json({ ok: true, user: { id: user.id, email: user.email }, next: safeDest });
  res.cookies.set(SESSION_COOKIE, cookie, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
  });
  return res;
}
