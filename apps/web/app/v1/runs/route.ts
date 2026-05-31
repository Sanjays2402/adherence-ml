/**
 * Public, key-authenticated runs listing endpoint.
 *
 *   curl http://localhost:3000/v1/runs?limit=10 \
 *     -H "authorization: Bearer adh_..."
 *
 * Requires an API key with the "read" scope. Returns a slim, scope-safe
 * view of recent runs so customers can ship dashboards, CSV exports, and
 * downstream pipelines without screen-scraping /history.
 */
import { NextRequest, NextResponse } from "next/server";
import { extractKey, hasScope, verifyKey } from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { listRuns, type RunKind } from "@/lib/runs-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KINDS = ["predict", "demo", "explain", "cohort", "forecast", "other"] as const;

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

  const sp = req.nextUrl.searchParams;
  const kindRaw = sp.get("kind");
  const kind =
    kindRaw && (KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as RunKind)
      : "all";
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 25), 1), 100);
  const offset = Math.max(Number(sp.get("offset") ?? 0), 0);
  const q = sp.get("q") ?? undefined;

  const { items, total } = await listRuns({ kind, limit, offset, q });
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/runs",
    status: 200,
    latency_ms: 0,
  }).catch(() => {});
  return NextResponse.json({
    total,
    limit,
    offset,
    items: items.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      user_id: r.user_id,
      latency_ms: r.latency_ms,
      tags: r.tags,
      shared: Boolean(r.share_token),
    })),
  });
}
