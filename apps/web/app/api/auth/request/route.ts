import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { issueMagicToken, isValidEmail, normalizeEmail } from "@/lib/users-store";

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
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Email is required." } },
      { status: 400 },
    );
  }
  const email = normalizeEmail(parsed.data.email);
  if (!isValidEmail(email)) {
    return NextResponse.json(
      { error: { code: "invalid_email", message: "Enter a valid email address." } },
      { status: 400 },
    );
  }

  const { token, expires_at } = await issueMagicToken(email);

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
