import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readSettings, writeSettings, validatePatch } from "@/lib/settings-store";

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
  const next = await writeSettings(parsed.data);
  return NextResponse.json(next);
}
