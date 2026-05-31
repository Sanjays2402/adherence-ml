import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { issueMagicToken, isValidEmail, normalizeEmail } from "@/lib/users-store";
import { findSsoForEmail } from "@/lib/workspaces-store";
import { recordAuthEvent } from "@/lib/auth-audit";
import {
  checkLockout,
  clientIpFromRequest,
  recordFailure,
} from "@/lib/login-throttle";

export const runtime = "nodejs";

function lockoutResponse(
  scope: "magic_request" | "totp_verify",
  lockedKey: string,
  retryAfterMs: number,
) {
  const retrySec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return NextResponse.json(
    {
      error: {
        code: "locked_out",
        message:
          "Too many sign-in attempts. Try again later or contact your workspace admin.",
        retry_after_seconds: retrySec,
        scope,
        key: lockedKey,
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retrySec),
        "X-RateLimit-Scope": scope,
      },
    },
  );
}

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

  // Brute-force / mailbox-pump throttle: refuse magic-link issuance when
  // either the target email or the client IP is currently locked out.
  const ip = clientIpFromRequest(req);
  const emailLock = await checkLockout("magic_request", email);
  if (!emailLock.ok) {
    await recordAuthEvent({
      verb: "login_request",
      method: "magic_link",
      outcome: "denied",
      reason: "locked_out_email",
      email,
      request: req,
    });
    return lockoutResponse("magic_request", email, emailLock.retry_after_ms);
  }
  const ipLock = await checkLockout("magic_request", ip);
  if (!ipLock.ok) {
    await recordAuthEvent({
      verb: "login_request",
      method: "magic_link",
      outcome: "denied",
      reason: "locked_out_ip",
      email,
      request: req,
    });
    return lockoutResponse("magic_request", ip, ipLock.retry_after_ms);
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
  // Issuance counts as one attempt against the rolling window: this is
  // what stops an attacker from spamming the user's mailbox even when no
  // login ever succeeds. Successful sign-in (in /api/auth/verify) does
  // not need to clear it because the window expires naturally.
  await recordFailure("magic_request", email);
  await recordFailure("magic_request", ip);
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
