import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { issueMagicToken, isValidEmail, normalizeEmail } from "@/lib/users-store";
import { findSsoForEmail } from "@/lib/workspaces-store";
import { recordAuthEvent } from "@/lib/auth-audit";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().min(3).max(254),
});

export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json(
      { error: { code: "bad_json", message: "Request body must be JSON." } },
      { status: 400 },
    );
  }
  if (!parsed.success) {
    await recordAuthEvent({
      verb: "login_request",
      method: "magic_link",
      outcome: "failure",
      reason: "invalid_input",
      request: req,
    });
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Email is required." } },
      { status: 400 },
    );
  }
  const email = normalizeEmail(parsed.data.email);
  if (!isValidEmail(email)) {
    await recordAuthEvent({
      verb: "login_request",
      method: "magic_link",
      outcome: "failure",
      reason: "invalid_email",
      email,
      request: req,
    });
    return NextResponse.json(
      { error: { code: "invalid_email", message: "Enter a valid email address." } },
      { status: 400 },
    );
  }

  // SSO enforcement: if this email's workspace requires SSO, refuse to
  // mint a magic link. Tell the caller where to go instead.
  const ssoMatch = await findSsoForEmail(email);
  if (ssoMatch && ssoMatch.sso.enforce) {
    await recordAuthEvent({
      verb: "login_request",
      method: "magic_link",
      outcome: "denied",
      reason: "sso_required",
      email,
      workspaceId: ssoMatch.workspace.id,
      request: req,
    });
    return NextResponse.json(
      {
        error: {
          code: "sso_required",
          message: `${ssoMatch.workspace.name} requires single sign-on. Use the SSO button instead.`,
        },
        sso: {
          workspace_id: ssoMatch.workspace.id,
          workspace_name: ssoMatch.workspace.name,
          label: ssoMatch.sso.label,
          start_url: `/api/auth/sso/start?workspace=${encodeURIComponent(ssoMatch.workspace.id)}`,
        },
      },
      { status: 403 },
    );
  }

  const { token, expires_at } = await issueMagicToken(email);
  await recordAuthEvent({
    verb: "login_request",
    method: "magic_link",
    outcome: "success",
    email,
    request: req,
  });

  // Build absolute URL using the request's own host so the link works
  // both on localhost and behind reverse proxies.
  const origin = req.nextUrl.origin;
  const link = `${origin}/verify?token=${encodeURIComponent(token)}`;

  // In production this is where you would hand off to your email provider
  // (Resend, Postmark, SES). For now we log the link server-side so the
  // dev flow is fully self-contained without leaking the token in HTTP
  // responses for any non-dev caller.
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    // eslint-disable-next-line no-console
    console.log(`[auth] magic link for ${email}: ${link}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[auth] magic link issued for ${email} (expires ${new Date(expires_at).toISOString()})`);
  }

  // Always respond identically so callers cannot enumerate registered users.
  const body: Record<string, unknown> = {
    ok: true,
    expires_at,
    message: "Check your email for a sign-in link. It expires in 15 minutes.",
  };
  if (isDev) {
    // Surface the link in dev so the UI can show it without forcing the
    // developer to tail server logs. Never enabled in production.
    body.dev_link = link;
  }
  return NextResponse.json(body);
}
