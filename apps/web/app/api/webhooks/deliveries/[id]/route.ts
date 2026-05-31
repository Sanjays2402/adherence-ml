import { NextRequest, NextResponse } from "next/server";
import { getDelivery } from "@/lib/webhooks-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const delivery = await getDelivery(id);
  if (!delivery) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ delivery });
}
