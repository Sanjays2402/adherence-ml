/**
 * Public, key-authenticated share-link toggle for a single run.
 *
 *   # Mint or reuse a share token
 *   curl -X POST http://localhost:3000/v1/runs/<id>/share \
 *     -H "authorization: Bearer adh_..." \
 *     -H "content-type: application/json" \
 *     -d '{"enable":true}'
 *
 *   # Revoke
 *   curl -X POST http://localhost:3000/v1/runs/<id>/share \
 *     -H "authorization: Bearer adh_..." \
 *     -H "content-type: application/json" \
 *     -d '{"enable":false}'
 *
 * Requires the "predict" scope. Returns the public share URL when enabled
 * so customers can plumb shareable links straight into their own UI.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { extractKey, hasScope, verifyKey } from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { setRunShared } from "@/lib/runs-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({ enable: z.boolean() });

export async function POST(
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
  if (!hasScope(key, "predict")) {
    return NextResponse.json(
      {
        detail: "this key is missing the 'predict' scope",
        required_scope: "predict",
        key_scopes: key.scopes ?? [],
      },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  if (!id || typeof id !== "string" || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ detail: "invalid run id" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "validation_failed", errors: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const updated = await setRunShared(id, parsed.data.enable);
  if (!updated) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "POST",
      path: "/v1/runs/[id]/share",
      status: 404,
      latency_ms: 0,
    }).catch(() => {});
    return NextResponse.json({ detail: "run not found" }, { status: 404 });
  }

  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "POST",
    path: "/v1/runs/[id]/share",
    status: 200,
    latency_ms: 0,
  }).catch(() => {});

  return NextResponse.json({
    id: updated.id,
    shared: Boolean(updated.share_token),
    share_token: updated.share_token ?? null,
    share_url: updated.share_token ? `/share/${updated.share_token}` : null,
    shared_at: updated.shared_at ?? null,
  });
}
