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
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { rateLimitHeaders, readBudget } from "@/lib/v1-ratelimit";


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
  // Read-only call: advertise current headroom on the standard headers
  // without consuming a unit. Lets SDKs poll this endpoint to drive
  // back-off and dashboards without hitting the billable predict path.
  const budget = await readBudget(key);
  const headers = rateLimitHeaders(budget, 0);
  return NextResponse.json(
    {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scopes,
      created_at: key.created_at,
      last_used_at: key.last_used_at,
      use_count: key.use_count,
      rotated_at: key.rotated_at ?? null,
      expires_at: key.expires_at ?? null,
      rate_limit: {
        limit: budget.limit,
        remaining: budget.remaining,
        reset: budget.reset,
        scope: budget.scope,
        plan: budget.plan,
        key: budget.key,
      },
    },
    { headers },
  );
}
