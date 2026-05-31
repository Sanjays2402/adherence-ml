import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { wipeAllData } from "@/lib/settings-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Schema = z.object({
  confirm: z.literal("DELETE EVERYTHING"),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        detail:
          'destructive action requires {"confirm":"DELETE EVERYTHING"} in the request body',
      },
      { status: 400 },
    );
  }
  const report = await wipeAllData();
  return NextResponse.json({ ok: true, ...report });
}
