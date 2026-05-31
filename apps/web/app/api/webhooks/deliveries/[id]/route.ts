import { NextRequest, NextResponse } from "next/server";
import { getDelivery } from "@/lib/webhooks-store";
import { requireDashboardAuth } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireDashboardAuth(req, {
    action: "webhook.delivery.read",
  });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const delivery = await getDelivery(id);
  if (!delivery) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ delivery });
}
