import { NextResponse, type NextRequest } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  isGithubOAuthConfigured,
  verifyOAuthState,
} from "@/lib/oauth-state";
import {
  getOrCreateUserByEmail,
  hasTotpEnabled,
  isValidEmail,
  normalizeEmail,
} from "@/lib/users-store";
import { findSsoForEmail } from "@/lib/workspaces-store";
import {
  MFA_PENDING_COOKIE,
  SESSION_COOKIE,
  buildMfaPending,
  buildSession,
  requestContextFromHeaders,
  mfaRequiredButMissing,
} from "@/lib/session";
import { recordAuthEvent } from "@/lib/auth-audit";

export const runtime = "nodejs";

interface GhTokenResp {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GhEmail {
  email: string;
  primary?: boolean;
  verified?: boolean;
}

interface GhUser {
  email?: string | null;
  login?: string;
}

async function fetchPrimaryEmail(accessToken: string): Promise<string | null> {
  const ua = "adherence-ml-oauth";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": ua,
  };
  // /user first (cheap, may already include a public primary email)
  try {
    const ur = await fetch("https://api.github.com/user", { headers, cache: "no-store" });
    if (ur.ok) {
      const u = (await ur.json()) as GhUser;
      if (u.email && isValidEmail(u.email)) return normalizeEmail(u.email);
    }
  } catch {
    // ignore, fall through to /user/emails
  }
  try {
    const er = await fetch("https://api.github.com/user/emails", { headers, cache: "no-store" });
    if (!er.ok) return null;
    const emails = (await er.json()) as GhEmail[];
    if (!Array.isArray(emails)) return null;
    const primary = emails.find((e) => e.primary && e.verified && isValidEmail(e.email));
    if (primary) return normalizeEmail(primary.email);
    const anyVerified = emails.find((e) => e.verified && isValidEmail(e.email));
    if (anyVerified) return normalizeEmail(anyVerified.email);
    return null;
  } catch {
    return null;
  }
}

/**
 * GitHub OAuth callback. Validates state, exchanges code for token, fetches
 * the verified primary email, and issues an adherence-ml session cookie.
 */
export async function GET(req: NextRequest) {
  if (!isGithubOAuthConfigured()) {
    return NextResponse.redirect(new URL("/login?error=oauth_unconfigured", req.url));
  }
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const stateQs = url.searchParams.get("state");
  const stateCookie = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!code || !stateQs || !stateCookie || stateQs !== stateCookie) {
    return NextResponse.redirect(new URL("/login?error=oauth_state", req.url));
  }
  const payload = verifyOAuthState(stateCookie, "github");
  if (!payload) {
    return NextResponse.redirect(new URL("/login?error=oauth_state", req.url));
  }

  // Exchange the code for an access token.
  let token: string | null = null;
  try {
    const tr = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "adherence-ml-oauth",
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: new URL("/api/auth/github/callback", url.origin).toString(),
      }),
      cache: "no-store",
    });
    if (!tr.ok) {
      return NextResponse.redirect(new URL("/login?error=oauth_exchange", req.url));
    }
    const tok = (await tr.json()) as GhTokenResp;
    if (!tok.access_token) {
      return NextResponse.redirect(new URL("/login?error=oauth_exchange", req.url));
    }
    token = tok.access_token;
  } catch {
    return NextResponse.redirect(new URL("/login?error=oauth_exchange", req.url));
  }

  const email = await fetchPrimaryEmail(token);
  if (!email) {
    await recordAuthEvent({ verb: "sso_callback", method: "github", outcome: "failure", reason: "no_verified_email", request: req });
    return NextResponse.redirect(new URL("/login?error=oauth_no_email", req.url));
  }

  // SSO enforcement: refuse GitHub OAuth for emails whose workspace
  // requires SSO. They must go through their IdP, not a personal GitHub.
  const ssoMatch = await findSsoForEmail(email);
  if (ssoMatch && ssoMatch.sso.enforce) {
    await recordAuthEvent({ verb: "login", method: "github", outcome: "denied", email, reason: "sso_required", metadata: { workspace_id: ssoMatch.workspace.id }, request: req });
    return NextResponse.redirect(new URL("/login?error=sso_required", req.url));
  }

  const user = await getOrCreateUserByEmail(email);
  const dest = payload.nx || "/";
  if (hasTotpEnabled(user)) {
    await recordAuthEvent({ verb: "login", method: "github", outcome: "success", email: user.email, userId: user.id, metadata: { mfa_required: true }, request: req });
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
  if (await mfaRequiredButMissing(user)) {
    await recordAuthEvent({ verb: "login", method: "github", outcome: "denied", email: user.email, userId: user.id, reason: "mfa_enrollment_required", request: req });
    const res = NextResponse.redirect(
      new URL("/login?error=mfa_enrollment_required", req.url),
    );
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }
  const { cookie, expires } = await buildSession(
    user,
    requestContextFromHeaders(req.headers, "github"),
  );
  await recordAuthEvent({ verb: "login", method: "github", outcome: "success", email: user.email, userId: user.id, request: req });
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
