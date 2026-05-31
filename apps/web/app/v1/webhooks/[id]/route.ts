/**
 * Key-authenticated delete for a single webhook endpoint.
 *
 *   curl -X DELETE http://localhost:3000/v1/webhooks/<id> \
 *     -H "authorization: Bearer adh_..."
 *
 * Requires the `webhooks` scope.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  extractKey,
  hasScope,
  scopesOf,
  verifyKey,
} from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { deleteEndpoint, getEndpoint } from "@/lib/webhooks-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const started = Date.now();
  const { id } = await ctx.params;
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
  if (!hasScope(key, "webhooks")) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "DELETE",
      path: `/v1/webhooks/${id}`,
      status: 403,
      latency_ms: Date.now() - started,
    }).catch(() => {});
    return NextResponse.json(
      {
        detail: "this api key is missing the 'webhooks' scope.",
        key_scopes: scopesOf(key),
        required_scope: "webhooks",
      },
      { status: 403 },
    );
  }
  const existing = await getEndpoint(id);
  if (!existing) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "DELETE",
      path: `/v1/webhooks/${id}`,
      status: 404,
      latency_ms: Date.now() - started,
    }).catch(() => {});
    return NextResponse.json(
      { detail: "endpoint not found" },
      { status: 404 },
    );
  }
  await deleteEndpoint(id);
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "DELETE",
    path: `/v1/webhooks/${id}`,
    status: 200,
    latency_ms: Date.now() - started,
  }).catch(() => {});
  return NextResponse.json({ ok: true, id });
}
