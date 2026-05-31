/**
 * Read-only key introspection. Customers can call this to confirm a key is
 * valid, see which scopes it carries, and watch usage tick up without
 * spending /v1/predict quota. Requires the `read` scope.
 *
 *   curl http://localhost:3000/v1/keys/me \
 *     -H "authorization: Bearer adh_..."
 */
import { NextRequest, NextResponse } from "next/server";
import { extractKey, hasScope, scopesOf, verifyKey } from "@/lib/api-keys-store";

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
  const key = await verifyKey(presented);
  if (!key) {
    return NextResponse.json({ detail: "invalid or revoked api key" }, { status: 401 });
  }
  const scopes = scopesOf(key);
  if (!hasScope(key, "read")) {
    return NextResponse.json(
      {
        detail: "this api key is missing the 'read' scope.",
        key_scopes: scopes,
        required_scope: "read",
      },
      { status: 403 },
    );
  }
  return NextResponse.json({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    use_count: key.use_count,
    rotated_at: key.rotated_at ?? null,
  });
}
