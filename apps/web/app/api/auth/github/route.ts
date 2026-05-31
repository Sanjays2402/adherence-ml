import { NextResponse, type NextRequest } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  buildOAuthState,
  isGithubOAuthConfigured,
} from "@/lib/oauth-state";

export const runtime = "nodejs";

/**
 * Start the GitHub OAuth flow. Sets a signed state cookie and redirects
 * the browser to GitHub's authorize endpoint with the matching state value.
 */
export async function GET(req: NextRequest) {
  if (!isGithubOAuthConfigured()) {
    return NextResponse.redirect(new URL("/login?error=oauth_unconfigured", req.url));
  }
  const next = req.nextUrl.searchParams.get("next");
  const state = buildOAuthState("github", next);
  const redirectUri = new URL("/api/auth/github/callback", req.nextUrl.origin).toString();
  const auth = new URL("https://github.com/login/oauth/authorize");
  auth.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("scope", "read:user user:email");
  auth.searchParams.set("state", state);
  auth.searchParams.set("allow_signup", "true");
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
