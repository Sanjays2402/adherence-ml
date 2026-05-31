import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createSchedule,
  listSchedules,
} from "@/lib/schedules-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DoseSchema = z.object({
  dose_id: z.string().min(1),
  scheduled_at: z.string().min(1),
  dose_class: z.string().min(1),
  dose_strength_mg: z.number().nonnegative(),
});

const PostSchema = z.object({
  name: z.string().min(1).max(80),
  cadence: z.enum(["daily", "weekly"]),
  hour_utc: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  payload: z.object({
    user_id: z.string().min(1),
    doses: z.array(DoseSchema).min(1).max(50),
    top_k: z.number().int().min(1).max(50).optional(),
  }),
});

export async function GET() {
  const items = await listSchedules();
  return NextResponse.json({ schedules: items });
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = PostSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  if (parsed.data.cadence === "weekly" && parsed.data.weekday == null) {
    return NextResponse.json(
      { error: "validation_failed", detail: "weekly schedules require weekday (0-6)" },
      { status: 422 },
    );
  }
  const sch = await createSchedule(parsed.data);
  return NextResponse.json({ schedule: sch }, { status: 201 });
}
