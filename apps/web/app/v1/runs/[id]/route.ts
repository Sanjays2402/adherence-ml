/**
 * Public, key-authenticated single-run fetch endpoint.
 *
 *   curl http://localhost:3000/v1/runs/<id> \
 *     -H "authorization: Bearer adh_..."
 *
 * Requires an API key with the "read" scope. Returns the full run record
 * (including the raw payload blob) so downstream pipelines can replay,
 * audit, or post-process a specific run found via GET /v1/runs.
 */
import { NextRequest, NextResponse } from "next/server";
import { extractKey, hasScope, verifyKey } from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { getRun } from "@/lib/runs-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const presented = extractKey(req.headers);
  if (!presented) {
    return NextResponse.json(
      { detail: "missing api key. send Authorization: Bearer <key> or x-api-key: <key>" },
      { status: 401 },
    );
  }
  const key = await verifyKey(presented);
  if (!key) {
    return NextResponse.json({ detail: "invalid or revoked api key" }, { status: 401 });
  }
  if (!hasScope(key, "read")) {
    return NextResponse.json(
      {
        detail: "this key is missing the 'read' scope",
        required_scope: "read",
        key_scopes: key.scopes ?? [],
      },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  if (!id || typeof id !== "string" || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json(
      { detail: "invalid run id" },
      { status: 400 },
    );
  }

  const rec = await getRun(id);
  if (!rec) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "GET",
      path: "/v1/runs/[id]",
      status: 404,
      latency_ms: 0,
    }).catch(() => {});
    return NextResponse.json({ detail: "run not found" }, { status: 404 });
  }

  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/runs/[id]",
    status: 200,
    latency_ms: 0,
  }).catch(() => {});
  return NextResponse.json({
    id: rec.id,
    created_at: rec.created_at,
    kind: rec.kind,
    title: rec.title,
    summary: rec.summary,
    user_id: rec.user_id,
    latency_ms: rec.latency_ms,
    tags: rec.tags,
    shared: Boolean(rec.share_token),
    share_url: rec.share_token ? `/share/${rec.share_token}` : null,
    payload: rec.payload,
  });
}
