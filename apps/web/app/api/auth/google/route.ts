import { NextResponse, type NextRequest } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  buildOAuthState,
  isGoogleOAuthConfigured,
} from "@/lib/oauth-state";

export const runtime = "nodejs";

/**
 * Start the Google OAuth flow. Sets a signed state cookie and redirects
 * the browser to Google's authorize endpoint with the matching state value.
 *
 * Scopes are limited to the user's email address and basic profile so we
 * can resolve a stable account identity. We never request Drive, Gmail,
 * or any write scope.
 */
export async function GET(req: NextRequest) {
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.redirect(new URL("/login?error=oauth_unconfigured", req.url));
  }
  const next = req.nextUrl.searchParams.get("next");
  const state = buildOAuthState("google", next);
  const redirectUri = new URL("/api/auth/google/callback", req.nextUrl.origin).toString();
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("access_type", "online");
  auth.searchParams.set("prompt", "select_account");
  const res = NextResponse.redirect(auth.toString());
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
  });
  return res;
}
