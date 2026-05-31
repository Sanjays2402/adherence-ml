import { NextRequest, NextResponse } from "next/server";
import { getEndpoint } from "@/lib/webhooks-store";
import { dispatchTest } from "@/lib/webhook-dispatch";
import { auditAction, requireDashboardAuth } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireDashboardAuth(req, {
    action: "webhook.endpoint.test",
    target: `webhook_endpoint:${id}`,
  });
  if (!auth.ok) return auth.response;
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
  await auditAction(req, auth.ctx, {
    action: "webhook.endpoint.test",
    target: `webhook_endpoint:${id}`,
    outcome: delivery.delivered ? "success" : "denied",
    metadata: {
      delivery_id: delivery.id,
      delivered: delivery.delivered,
      attempts: delivery.attempts.length,
      url: ep.url,
    },
  });
  return NextResponse.json({
    delivery_id: delivery.id,
    delivered: delivery.delivered,
    attempts: delivery.attempts,
  });
}
