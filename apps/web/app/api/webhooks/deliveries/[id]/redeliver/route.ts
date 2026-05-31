import { NextRequest, NextResponse } from "next/server";
import { getDelivery, getEndpoint } from "@/lib/webhooks-store";
import { redeliver } from "@/lib/webhook-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const source = await getDelivery(id);
  if (!source) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ep = await getEndpoint(source.endpoint_id);
  if (!ep) {
    return NextResponse.json(
      { error: "endpoint_missing", detail: "the original endpoint has been deleted" },
      { status: 410 },
    );
  }
  if (!ep.active) {
    return NextResponse.json(
      { error: "inactive", detail: "enable the endpoint before redelivering" },
      { status: 409 },
    );
  }
  const fresh = await redeliver(ep, source);
  if (!fresh) {
    return NextResponse.json({ error: "dispatch_failed" }, { status: 500 });
  }
  return NextResponse.json({
    delivery_id: fresh.id,
    source_id: source.id,
    delivered: fresh.delivered,
    attempts: fresh.attempts.length,
  });
}
