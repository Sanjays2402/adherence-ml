import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteEndpoint,
  setEndpointActive,
  getEndpoint,
  listDeliveries,
} from "@/lib/webhooks-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({ active: z.boolean() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
  const updated = await setEndpointActive(id, parsed.data.active);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
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
  return NextResponse.json({ ok: true });
}
