import { NextRequest, NextResponse } from "next/server";
import { getSchedule } from "@/lib/schedules-store";
import { fireSchedule } from "@/lib/schedule-fire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sch = await getSchedule(id);
  if (!sch) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const result = await fireSchedule(sch);
  return NextResponse.json({ result });
}
