import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  currentDigest,
  listSent,
  logSend,
  renderDigestHtml,
} from "@/lib/digest-store";
import { readSettings } from "@/lib/settings-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/digest
 *   ?format=html  -> returns the rendered email body (text/html)
 *   default       -> returns the structured payload + sent log
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const format = url.searchParams.get("format");
  const payload = await currentDigest();
  if (format === "html") {
    const settings = await readSettings();
    const appUrl = url.origin || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const html = renderDigestHtml(payload, {
      recipient: settings.profile.contact_email || undefined,
      appUrl,
    });
    return new NextResponse(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const settings = await readSettings();
  const sent = await listSent(10);
  return NextResponse.json({
    payload,
    recipient: settings.profile.contact_email || null,
    enabled: settings.notifications.email_weekly_digest,
    sent,
  });
}

const PostSchema = z.object({
  to: z.string().email().optional(),
  force: z.boolean().optional(),
});

/**
 * POST /api/digest -> records a "send" attempt for the current digest.
 *
 * No SMTP transport ships in this repo; the route persists a SendRecord
 * so the UI can show a timestamped audit trail. Swap in Resend/SES by
 * importing renderDigestHtml and POSTing to your provider.
 */
export async function POST(req: NextRequest) {
  let json: unknown = {};
  try {
    json = await req.json();
  } catch {
    // empty body is allowed
  }
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const settings = await readSettings();
  const to = parsed.data.to ?? settings.profile.contact_email;
  if (!to) {
    return NextResponse.json(
      { error: "no_recipient", detail: "Set a contact email in /settings or pass {to} in the body." },
      { status: 400 },
    );
  }
  if (!settings.notifications.email_weekly_digest && !parsed.data.force) {
    return NextResponse.json(
      {
        error: "digest_unsubscribed",
        detail: "Weekly digest email is turned off in /settings. Re-enable it, or POST with {force:true} to override once.",
      },
      { status: 409 },
    );
  }
  const payload = await currentDigest();
  const rec = await logSend(to, payload, "logged");
  return NextResponse.json({ ok: true, sent: rec, runs_total: payload.runs_total });
}
