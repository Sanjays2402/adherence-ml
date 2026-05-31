import { NextResponse } from "next/server";

import { getShare } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const record = await getShare(id);
  if (!record) {
    return NextResponse.json(
      { error: "not_found", detail: `no share with id ${id}` },
      { status: 404 },
    );
  }
  return NextResponse.json(record);
}
