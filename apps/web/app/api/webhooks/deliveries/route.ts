import { NextRequest, NextResponse } from "next/server";
import { listDeliveries, type DeliveryStatusFilter } from "@/lib/webhooks-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: readonly DeliveryStatusFilter[] = ["all", "ok", "failed", "pending"];

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const endpoint_id = sp.get("endpoint_id") ?? undefined;
  const limit = Number(sp.get("limit") ?? 50);
  const rawStatus = sp.get("status") ?? "all";
  const status = STATUSES.includes(rawStatus as DeliveryStatusFilter)
    ? (rawStatus as DeliveryStatusFilter)
    : "all";
  const deliveries = await listDeliveries({
    endpoint_id,
    limit: Number.isFinite(limit) ? limit : 50,
    status,
  });
  return NextResponse.json({ deliveries });
}
