/**
 * Public, key-authenticated audit-chain integrity check.
 *
 * Recomputes the SHA-256 hash chain across the dashboard audit log and
 * returns the tip hash plus a boolean. Lets a customer schedule a daily
 * "is our audit log still intact?" probe from their SIEM and alert on
 * any drift. Requires the `audit` scope. Read-only.
 *
 *   curl http://localhost:3000/v1/audit/verify \
 *     -H "authorization: Bearer adh_..."
 *
 *   { "chain_valid": true, "tip_hash": "abc...", "entries": 142 }
 */
import { NextRequest, NextResponse } from "next/server";
import { extractKey, hasScope, scopesOf, verifyKey } from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { listAudit } from "@/lib/dashboard-audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const presented = extractKey(req.headers);
  if (!presented) {
    return NextResponse.json(
      { detail: "missing api key" },
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
  if (!hasScope(key, "audit")) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "GET",
      path: "/v1/audit/verify",
      status: 403,
      latency_ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json(
      {
        detail: "this api key is missing the 'audit' scope.",
        key_scopes: scopesOf(key),
        required_scope: "audit",
      },
      { status: 403 },
    );
  }

  // listAudit reads the whole log and recomputes the hash chain; cap at
  // the store's hard ceiling (1000) for the items echo, but `total`
  // reflects the post-filter count over the entire log.
  const result = await listAudit({ limit: 1 });

  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/audit/verify",
    status: 200,
    latency_ms: Date.now() - t0,
  }).catch(() => {});

  return NextResponse.json(
    {
      chain_valid: result.chain_valid,
      tip_hash: result.tip_hash,
      entries: result.total,
      checked_at: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "X-Audit-Tip-Hash": result.tip_hash ?? "",
        "X-Audit-Chain-Valid": result.chain_valid ? "true" : "false",
        "Cache-Control": "no-store",
      },
    },
  );
}
