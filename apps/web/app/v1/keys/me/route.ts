/**
 * Read-only key introspection. Customers can call this to confirm a key is
 * valid, see which scopes it carries, and watch usage tick up without
 * spending /v1/predict quota. Requires the `read` scope.
 *
 *   curl http://localhost:3000/v1/keys/me \
 *     -H "authorization: Bearer adh_..."
 */
import { NextRequest, NextResponse } from "next/server";
import { extractKey, hasActiveGrace, hasScope, scopesOf, verifyKeyDetailed } from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";


export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const presented = extractKey(req.headers);
  if (!presented) {
    return NextResponse.json(
      { detail: "missing api key. send Authorization: Bearer <key> or x-api-key: <key>" },
      { status: 401 },
    );
  }
  const verified = await verifyKeyDetailed(presented);
  if (!verified) {
    return NextResponse.json({ detail: "invalid or revoked api key" }, { status: 401 });
  }
  const key = verified.record;
  const scopes = scopesOf(key);
  if (!hasScope(key, "read")) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "GET",
      path: "/v1/keys/me",
      status: 403,
      latency_ms: 0,
    }).catch(() => {});
    return NextResponse.json(
      {
        detail: "this api key is missing the 'read' scope.",
        key_scopes: scopes,
        required_scope: "read",
      },
      { status: 403 },
    );
  }
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/keys/me",
    status: 200,
    latency_ms: 0,
  }).catch(() => {});
  return NextResponse.json({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    use_count: key.use_count,
    rotated_at: key.rotated_at ?? null,
    expires_at: key.expires_at ?? null,
    // When a grace window is active, callers still on the old secret get
    // `via_grace: true` so they can finish rolling out before the cutoff.
    via_grace: verified.viaGrace,
    previous_expires_at: hasActiveGrace(key) ? key.previous_expires_at ?? null : null,
  });
}
