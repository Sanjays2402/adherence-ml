/**
 * Dashboard-side redeliver for a recorded webhook delivery.
 *
 * Auth: requires a signed dashboard session (or ADHERENCE_DASHBOARD_OPEN=1
 * for local dev). Every call lands in the tamper-evident dashboard audit log
 * with the actor, the source delivery id, the endpoint id, and the outcome.
 *
 * Supports enterprise dry-run: ?dry_run=true (or X-Dry-Run: true) returns
 * what would happen without enqueueing a new delivery, so change-control
 * reviewers can preview a replay before approving it.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDelivery, getEndpoint } from "@/lib/webhooks-store";
import { redeliver } from "@/lib/webhook-dispatch";
import { auditAction, requireDashboardAuth } from "@/lib/dashboard-auth";
import { isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireDashboardAuth(req, {
    action: "webhooks.delivery.redeliver",
    target: id,
  });
  if (!auth.ok) return auth.response;

  const source = await getDelivery(id);
  if (!source) {
    await auditAction(req, auth.ctx, {
      action: "webhooks.delivery.redeliver",
      target: id,
      outcome: "failure",
      metadata: { reason: "not_found" },
    });
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ep = await getEndpoint(source.endpoint_id);
  if (!ep) {
    await auditAction(req, auth.ctx, {
      action: "webhooks.delivery.redeliver",
      target: id,
      outcome: "failure",
      metadata: { reason: "endpoint_missing", endpoint_id: source.endpoint_id },
    });
    return NextResponse.json(
      { error: "endpoint_missing", detail: "the original endpoint has been deleted" },
      { status: 410 },
    );
  }
  if (!ep.active) {
    await auditAction(req, auth.ctx, {
      action: "webhooks.delivery.redeliver",
      target: id,
      outcome: "denied",
      metadata: { reason: "endpoint_inactive", endpoint_id: ep.id },
    });
    return NextResponse.json(
      { error: "inactive", detail: "enable the endpoint before redelivering" },
      { status: 409 },
    );
  }

  if (isDryRun(req)) {
    await auditAction(req, auth.ctx, {
      action: "webhooks.delivery.redeliver",
      target: id,
      outcome: "success",
      metadata: {
        dry_run: true,
        endpoint_id: ep.id,
        event: source.event,
      },
    });
    return withDryRunHeaders(
      NextResponse.json({
        dry_run: true,
        would: "redeliver",
        preview: {
          resource: "webhook_delivery",
          id: source.id,
          summary: `would redeliver event ${source.event} to ${ep.url}`,
          cascade: [],
          before: {
            endpoint_id: ep.id,
            event: source.event,
            url: ep.url,
          },
        },
      }),
    );
  }

  const fresh = await redeliver(ep, source);
  if (!fresh) {
    await auditAction(req, auth.ctx, {
      action: "webhooks.delivery.redeliver",
      target: id,
      outcome: "failure",
      metadata: { reason: "dispatch_failed", endpoint_id: ep.id },
    });
    return NextResponse.json({ error: "dispatch_failed" }, { status: 500 });
  }

  await auditAction(req, auth.ctx, {
    action: "webhooks.delivery.redeliver",
    target: id,
    outcome: fresh.delivered ? "success" : "failure",
    metadata: {
      endpoint_id: ep.id,
      event: source.event,
      new_delivery_id: fresh.id,
      attempts: fresh.attempts.length,
      delivered: fresh.delivered,
    },
  });

  return NextResponse.json({
    delivery_id: fresh.id,
    source_id: source.id,
    delivered: fresh.delivered,
    attempts: fresh.attempts.length,
  });
}
