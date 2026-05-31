import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceSso } from "@/lib/workspaces-store";
import { SSO_STATE_COOKIE, buildSsoState, discover, pkceChallenge } from "@/lib/oidc";

export const runtime = "nodejs";

const SSO_STATE_TTL_SECS = 10 * 60;

/**
 * Start the per-workspace OIDC SSO flow. Requires ?workspace=<id>; the
 * caller is expected to have come from the login page (which already
 * knows which workspace to bounce them to via findSsoForEmail).
 */
export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspace");
  const next = req.nextUrl.searchParams.get("next");
  if (!workspaceId) {
    return NextResponse.redirect(new URL("/login?error=sso_missing_workspace", req.url));
  }
  const sso = await getWorkspaceSso(workspaceId);
  if (!sso) {
    return NextResponse.redirect(new URL("/login?error=sso_not_configured", req.url));
  }
  let doc;
  try {
    doc = await discover(sso.issuer);
  } catch {
    return NextResponse.redirect(new URL("/login?error=sso_discovery", req.url));
  }
  const { value: state, payload } = buildSsoState(workspaceId, next);
  const redirectUri = new URL("/api/auth/sso/callback", req.nextUrl.origin).toString();
  const auth = new URL(doc.authorization_endpoint);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", sso.client_id);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("scope", "openid email profile");
  auth.searchParams.set("state", state);
  auth.searchParams.set("nonce", payload.non);
  auth.searchParams.set("code_challenge", pkceChallenge(payload.cv));
  auth.searchParams.set("code_challenge_method", "S256");
  const res = NextResponse.redirect(auth.toString());
  res.cookies.set(SSO_STATE_COOKIE, state, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SSO_STATE_TTL_SECS,
  });
  return res;
}
