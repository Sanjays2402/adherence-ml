import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteSchedule,
  getSchedule,
  setActive,
} from "@/lib/schedules-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sch = await getSchedule(id);
  if (!sch) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ schedule: sch });
}

const PatchSchema = z.object({ active: z.boolean() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation_failed" }, { status: 422 });
  }
  const sch = await setActive(id, parsed.data.active);
  if (!sch) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ schedule: sch });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = await deleteSchedule(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
