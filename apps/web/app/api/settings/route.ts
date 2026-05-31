import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readSettings, writeSettings, validatePatch } from "@/lib/settings-store";
import { requireDashboardAuth, auditAction } from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const s = await readSettings();
  return NextResponse.json(s);
}

const PatchSchema = z.object({
  profile: z
    .object({
      display_name: z.string().max(80).optional(),
      contact_email: z.string().max(200).optional(),
      org: z.string().max(80).optional(),
      timezone: z.string().max(64).optional(),
    })
    .partial()
    .optional(),
  notifications: z
    .object({
      email_on_high_risk: z.boolean().optional(),
      email_weekly_digest: z.boolean().optional(),
      webhook_on_run_created: z.boolean().optional(),
      toast_on_long_run: z.boolean().optional(),
    })
    .partial()
    .optional(),
});

export async function PATCH(req: NextRequest) {
  const auth = await requireDashboardAuth(req, { action: "settings.patch" });
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const err = validatePatch(parsed.data);
  if (err) return NextResponse.json({ detail: err }, { status: 400 });
  const before = await readSettings();
  const next = await writeSettings(parsed.data);

  const diff: Record<string, { before: unknown; after: unknown }> = {};
  if (parsed.data.profile) {
    for (const k of Object.keys(parsed.data.profile)) {
      const key = k as keyof typeof before.profile;
      if (before.profile[key] !== next.profile[key]) {
        diff[`profile.${k}`] = { before: before.profile[key], after: next.profile[key] };
      }
    }
  }
  if (parsed.data.notifications) {
    for (const k of Object.keys(parsed.data.notifications)) {
      const key = k as keyof typeof before.notifications;
      if (before.notifications[key] !== next.notifications[key]) {
        diff[`notifications.${k}`] = {
          before: before.notifications[key],
          after: next.notifications[key],
        };
      }
    }
  }
  await auditAction(req, auth.ctx, {
    action: "settings.patch",
    target: "workspace.settings",
    metadata: { diff, fields: Object.keys(diff) },
  });
  return NextResponse.json(next);
}
