import { NextRequest, NextResponse } from "next/server";
import { getEndpoint } from "@/lib/webhooks-store";
import { dispatchTest } from "@/lib/webhook-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ep = await getEndpoint(id);
  if (!ep) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!ep.active)
    return NextResponse.json(
      { error: "inactive", detail: "enable the endpoint before sending a test" },
      { status: 409 },
    );
  const delivery = await dispatchTest(ep);
  if (!delivery)
    return NextResponse.json({ error: "dispatch_failed" }, { status: 500 });
  return NextResponse.json({
    delivery_id: delivery.id,
    delivered: delivery.delivered,
    attempts: delivery.attempts,
  });
}
