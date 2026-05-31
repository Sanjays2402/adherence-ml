/**
 * Key-authenticated read of webhook deliveries.
 *
 *   curl 'http://localhost:3000/v1/webhooks/deliveries?limit=20&status=failed' \
 *     -H "authorization: Bearer adh_..."
 *
 * Query params:
 *   - endpoint_id: filter to a single endpoint id
 *   - status: all|ok|failed|pending (default all)
 *   - limit: 1..500 (default 50)
 *
 * Requires the `webhooks` or `read` scope.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  clientIpFromHeaders,
  extractKey,
  hasScope,
  ipAllowedForKey,
  scopesOf,
  verifyKey,
} from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import {
  deliveryStatus,
  listDeliveries,
  type DeliveryStatusFilter,
} from "@/lib/webhooks-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: DeliveryStatusFilter[] = ["all", "ok", "failed", "pending"];

export async function GET(req: NextRequest) {
  const started = Date.now();
  const presented = extractKey(req.headers);
  if (!presented) {
    return NextResponse.json(
      {
        detail:
          "missing api key. send Authorization: Bearer <key> or x-api-key: <key>",
      },
      { status: 401 },
    );
  }
  const key = await verifyKey(presented);
  if (!key) {
    return NextResponse.json(
      { detail: "invalid or revoked api key" },
      { status: 401 },
    );
  }
  if (!ipAllowedForKey(key, clientIpFromHeaders(req.headers))) {
    return NextResponse.json(
      { detail: "source ip not allowed for this api key" },
      { status: 403 },
    );
  }
  if (!hasScope(key, "webhooks") && !hasScope(key, "read")) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "GET",
      path: "/v1/webhooks/deliveries",
      status: 403,
      latency_ms: Date.now() - started,
    }).catch(() => {});
    return NextResponse.json(
      {
        detail: "this api key is missing the 'webhooks' or 'read' scope.",
        key_scopes: scopesOf(key),
        required_scope: "webhooks",
      },
      { status: 403 },
    );
  }
  const sp = new URL(req.url).searchParams;
  const endpoint_id = sp.get("endpoint_id") ?? undefined;
  const rawStatus = sp.get("status") as DeliveryStatusFilter | null;
  const status: DeliveryStatusFilter =
    rawStatus && STATUSES.includes(rawStatus) ? rawStatus : "all";
  const limitRaw = Number(sp.get("limit") ?? "50");
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 50;

  const items = await listDeliveries({ endpoint_id, status, limit });
  const out = items.map((d) => ({
    id: d.id,
    endpoint_id: d.endpoint_id,
    event: d.event,
    url: d.url,
    created_at: d.created_at,
    finished_at: d.finished_at,
    delivered: d.delivered,
    status: deliveryStatus(d),
    attempts: d.attempts.length,
    last_status: d.attempts.length ? d.attempts[d.attempts.length - 1].status : null,
  }));
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/webhooks/deliveries",
    status: 200,
    latency_ms: Date.now() - started,
  }).catch(() => {});
  return NextResponse.json({ deliveries: out, count: out.length });
}
