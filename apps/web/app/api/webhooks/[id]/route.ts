import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteEndpoint,
  setEndpointActive,
  getEndpoint,
  listDeliveries,
} from "@/lib/webhooks-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { auditAction, requireDashboardAuth } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({ active: z.boolean() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireDashboardAuth(req, {
    action: "webhook.endpoint.toggle",
    target: `webhook_endpoint:${id}`,
  });
  if (!auth.ok) return auth.response;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const before = await getEndpoint(id);
  const updated = await setEndpointActive(id, parsed.data.active);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await auditAction(req, auth.ctx, {
    action: "webhook.endpoint.toggle",
    target: `webhook_endpoint:${id}`,
    metadata: {
      before: { active: before?.active ?? null },
      after: { active: updated.active },
    },
  });
  return NextResponse.json({
    id: updated.id,
    active: updated.active,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireDashboardAuth(req, {
    action: "webhook.endpoint.delete",
    target: `webhook_endpoint:${id}`,
  });
  if (!auth.ok) return auth.response;
  const existed = await getEndpoint(id);
  if (!existed) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (isDryRun(req)) {
    const deliveries = await listDeliveries({ endpoint_id: id, limit: 50, status: "all" });
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "webhook_endpoint",
          id,
          summary: `delete webhook endpoint '${existed.name || existed.url}'; ${deliveries.length} delivery row(s) reference this endpoint and will be orphaned`,
          cascade: deliveries.slice(0, 50).map((d) => ({
            resource: "webhook_delivery",
            id: d.id,
            label: `${d.event} at ${new Date(d.created_at).toISOString()}`,
          })),
          before: {
            id: existed.id,
            name: existed.name,
            url: existed.url,
            events: existed.events,
            active: existed.active,
          },
        }),
      ),
    );
  }

  await deleteEndpoint(id);
  await auditAction(req, auth.ctx, {
    action: "webhook.endpoint.delete",
    target: `webhook_endpoint:${id}`,
    metadata: {
      before: {
        id: existed.id,
        name: existed.name,
        url: existed.url,
        events: existed.events,
        active: existed.active,
      },
    },
  });
  return NextResponse.json({ ok: true });
}
