import { NextResponse, type NextRequest } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  isGoogleOAuthConfigured,
  verifyOAuthState,
} from "@/lib/oauth-state";
import {
  getOrCreateUserByEmail,
  hasTotpEnabled,
  isValidEmail,
  normalizeEmail,
} from "@/lib/users-store";
import {
  MFA_PENDING_COOKIE,
  SESSION_COOKIE,
  buildMfaPending,
  buildSession,
} from "@/lib/session";

export const runtime = "nodejs";

interface GoogleTokenResp {
  access_token?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string | null;
  email_verified?: boolean;
  name?: string;
}

async function fetchVerifiedEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const u = (await r.json()) as GoogleUserInfo;
    if (!u.email || !u.email_verified) return null;
    if (!isValidEmail(u.email)) return null;
    return normalizeEmail(u.email);
  } catch {
    return null;
  }
}

/**
 * Google OAuth callback. Validates state, exchanges code for token,
 * fetches the verified email via OpenID userinfo, and issues an
 * adherence-ml session cookie. Honours the per-user TOTP challenge.
 */
export async function GET(req: NextRequest) {
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.redirect(new URL("/login?error=oauth_unconfigured", req.url));
  }
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const stateQs = url.searchParams.get("state");
  const stateCookie = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!code || !stateQs || !stateCookie || stateQs !== stateCookie) {
    return NextResponse.redirect(new URL("/login?error=oauth_state", req.url));
  }
  const payload = verifyOAuthState(stateCookie, "google");
  if (!payload) {
    return NextResponse.redirect(new URL("/login?error=oauth_state", req.url));
  }

  // Exchange the authorization code for an access token.
  let token: string | null = null;
  try {
    const body = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: new URL("/api/auth/google/callback", url.origin).toString(),
    });
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      cache: "no-store",
    });
    if (!tr.ok) {
      return NextResponse.redirect(new URL("/login?error=oauth_exchange", req.url));
    }
    const tok = (await tr.json()) as GoogleTokenResp;
    if (!tok.access_token) {
      return NextResponse.redirect(new URL("/login?error=oauth_exchange", req.url));
    }
    token = tok.access_token;
  } catch {
    return NextResponse.redirect(new URL("/login?error=oauth_exchange", req.url));
  }

  const email = await fetchVerifiedEmail(token);
  if (!email) {
    return NextResponse.redirect(new URL("/login?error=oauth_no_email", req.url));
  }

  const user = await getOrCreateUserByEmail(email);
  const dest = payload.nx || "/";
  if (hasTotpEnabled(user)) {
    const { cookie, expires } = buildMfaPending(user, dest);
    const res = NextResponse.redirect(
      new URL(`/verify-2fa?next=${encodeURIComponent(dest.startsWith("/") ? dest : "/")}`, req.url),
    );
    res.cookies.set(MFA_PENDING_COOKIE, cookie, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires,
    });
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }
  const { cookie, expires } = buildSession(user);
  const res = NextResponse.redirect(new URL(dest, req.url));
  res.cookies.set(SESSION_COOKIE, cookie, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
  });
  // Burn the OAuth state cookie so it cannot be replayed.
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
