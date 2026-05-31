import { NextResponse, type NextRequest } from "next/server";
import { getWorkspaceSso, findSsoForEmail } from "@/lib/workspaces-store";
import { discover, verifyIdToken, verifySsoState, SSO_STATE_COOKIE } from "@/lib/oidc";
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
  requestContextFromHeaders,
  mfaRequiredButMissing,
} from "@/lib/session";

export const runtime = "nodejs";

interface TokenResp {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const stateQs = url.searchParams.get("state");
  const stateCookie = req.cookies.get(SSO_STATE_COOKIE)?.value;
  const idpError = url.searchParams.get("error");
  if (idpError) {
    return NextResponse.redirect(new URL(`/login?error=sso_idp_${encodeURIComponent(idpError)}`, req.url));
  }
  if (!code || !stateQs || !stateCookie || stateQs !== stateCookie) {
    return NextResponse.redirect(new URL("/login?error=sso_state", req.url));
  }
  const state = verifySsoState(stateCookie);
  if (!state) {
    return NextResponse.redirect(new URL("/login?error=sso_state", req.url));
  }
  const sso = await getWorkspaceSso(state.ws);
  if (!sso) {
    return NextResponse.redirect(new URL("/login?error=sso_not_configured", req.url));
  }

  let doc;
  try {
    doc = await discover(sso.issuer);
  } catch {
    return NextResponse.redirect(new URL("/login?error=sso_discovery", req.url));
  }

  // Exchange the code for tokens (with PKCE verifier).
  const redirectUri = new URL("/api/auth/sso/callback", url.origin).toString();
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri);
  form.set("client_id", sso.client_id);
  form.set("client_secret", sso.client_secret);
  form.set("code_verifier", state.cv);
  let tok: TokenResp;
  try {
    const tr = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
      cache: "no-store",
    });
    tok = (await tr.json()) as TokenResp;
    if (!tr.ok || !tok.id_token) {
      return NextResponse.redirect(new URL("/login?error=sso_exchange", req.url));
    }
  } catch {
    return NextResponse.redirect(new URL("/login?error=sso_exchange", req.url));
  }

  let claims;
  try {
    claims = await verifyIdToken(tok.id_token, {
      issuer: sso.issuer,
      client_id: sso.client_id,
      nonce: state.non,
    });
  } catch {
    return NextResponse.redirect(new URL("/login?error=sso_verify", req.url));
  }

  const email = typeof claims.email === "string" ? normalizeEmail(claims.email) : null;
  if (!email || !isValidEmail(email)) {
    return NextResponse.redirect(new URL("/login?error=sso_no_email", req.url));
  }
  if (claims.email_verified === false) {
    return NextResponse.redirect(new URL("/login?error=sso_unverified_email", req.url));
  }
  // Ensure the verified email's domain is one this workspace claims, so an
  // attacker can't point any IdP at our callback and get logged in as
  // someone in a domain that workspace doesn't own.
  const domain = email.split("@")[1] ?? "";
  if (!sso.allowed_email_domains.includes(domain)) {
    return NextResponse.redirect(new URL("/login?error=sso_domain_mismatch", req.url));
  }
  // Defensive: if another workspace also claims this domain with a different
  // SSO config, refuse rather than silently accept the wrong tenant's IdP.
  const claimingWs = await findSsoForEmail(email);
  if (claimingWs && claimingWs.workspace.id !== state.ws) {
    return NextResponse.redirect(new URL("/login?error=sso_domain_mismatch", req.url));
  }

  const user = await getOrCreateUserByEmail(email);
  const dest = state.nx || "/";
  const burn = (res: NextResponse) => {
    res.cookies.set(SSO_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };
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
    return burn(res);
  }
  if (await mfaRequiredButMissing(user)) {
    return burn(
      NextResponse.redirect(
        new URL("/login?error=mfa_enrollment_required", req.url),
      ),
    );
  }
  const { cookie, expires } = await buildSession(
    user,
    requestContextFromHeaders(req.headers, "sso"),
  );
  const res = NextResponse.redirect(new URL(dest, req.url));
  res.cookies.set(SESSION_COOKIE, cookie, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
  });
  return burn(res);
}
