import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  createNotification,
  listForUser,
  unreadCountForUser,
  type NotificationKind,
} from "@/lib/notifications-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  const uid = session?.user.id ?? null;
  const unreadOnly = req.nextUrl.searchParams.get("unread") === "1";
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, Math.min(500, parseInt(limitParam, 10) || 100)) : 100;

  const ALLOWED_KINDS: NotificationKind[] = [
    "run.completed",
    "batch.completed",
    "webhook.failed",
    "webhook.delivered",
    "system",
  ];
  const kindsParam = req.nextUrl.searchParams.get("kinds");
  const kinds = kindsParam
    ? (kindsParam
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is NotificationKind =>
          (ALLOWED_KINDS as string[]).includes(s),
        ))
    : undefined;

  const items = await listForUser(uid, { unreadOnly, limit, kinds });
  const unread = await unreadCountForUser(uid);
  return NextResponse.json({ items, unread, authenticated: !!uid });
}

const KINDS = [
  "run.completed",
  "batch.completed",
  "webhook.failed",
  "webhook.delivered",
  "system",
] as const;

const PostSchema = z.object({
  user_id: z.string().nullable().optional(),
  kind: z.enum(KINDS).default("system"),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).default(""),
  href: z.string().max(500).nullable().optional(),
});

/**
 * POST is used by server-side code paths and admins to seed system
 * broadcasts. Unauthenticated requests can only target themselves
 * (effectively no-op since there is no session) or be denied.
 */
export async function POST(req: NextRequest) {
  const session = await getSession(req);
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  // anonymous callers cannot target other users; force user_id to their own (or null)
  let user_id = parsed.data.user_id ?? null;
  if (!session && user_id !== null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session && user_id !== null && user_id !== session.user.id) {
    // only system code (no session) should target other users; keep this strict
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rec = await createNotification({
    user_id,
    kind: parsed.data.kind,
    title: parsed.data.title,
    body: parsed.data.body ?? "",
    href: parsed.data.href ?? null,
  });
  return NextResponse.json({ notification: rec }, { status: 201 });
}
