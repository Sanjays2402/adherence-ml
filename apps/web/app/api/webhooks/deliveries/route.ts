import { NextRequest, NextResponse } from "next/server";
import { listDeliveries } from "@/lib/webhooks-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const endpoint_id = sp.get("endpoint_id") ?? undefined;
  const limit = Number(sp.get("limit") ?? 50);
  const deliveries = await listDeliveries({
    endpoint_id,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return NextResponse.json({ deliveries });
}
