/**
 * Public, key-authenticated usage endpoint.
 *
 *   curl http://localhost:3000/v1/usage \
 *     -H "authorization: Bearer adh_..."
 *
 * Returns the same shape the /usage dashboard renders, so customers can
 * wire their own quota meters, billing alerts, and CI guardrails without
 * scraping HTML. Requires the `read` scope. Does not consume quota: this
 * is metadata about quota, not a billable call.
 *
 * Response headers:
 *   X-RateLimit-Limit         daily quota for the account
 *   X-RateLimit-Remaining     remaining requests today
 *   X-RateLimit-Reset         epoch seconds when the UTC day rolls over
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
import { summary } from "@/lib/usage-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function nextUtcMidnightSec(): number {
  const now = new Date();
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return Math.floor(next / 1000);
}

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
  if (!ipAllowedForKey(key, clientIpFromHeaders(req.headers))) {
    return NextResponse.json(
      { detail: "source ip not allowed for this api key" },
      { status: 403 },
    );
  }
  const scopes = scopesOf(key);
  if (!hasScope(key, "read")) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "GET",
      path: "/v1/usage",
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

  const t0 = Date.now();
  const s = await summary();
  const latency = Date.now() - t0;
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/usage",
    status: 200,
    latency_ms: latency,
  }).catch(() => {});

  const reset = nextUtcMidnightSec();
  return NextResponse.json(
    {
      quota: s.quota,
      used_today: s.used_today,
      remaining_today: s.remaining_today,
      pct_today: s.pct_today,
      used_30d: s.used_30d,
      reset_at: reset,
      days: s.days, // 30 buckets, ascending, with .date and .total
      by_key_30d: s.by_key_30d, // [{ key_id, count }]
    },
    {
      status: 200,
      headers: {
        "X-RateLimit-Limit": String(s.quota),
        "X-RateLimit-Remaining": String(s.remaining_today),
        "X-RateLimit-Reset": String(reset),
        "Cache-Control": "no-store",
      },
    },
  );
}
