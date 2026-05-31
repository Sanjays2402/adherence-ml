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
import { z } from "zod";
import { extractKey, hasScope, verifyKey } from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import {
  appendRun,
  listRuns,
  newRunId,
  type RunKind,
  type RunRecord,
} from "@/lib/runs-store";

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

const PostSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().min(1).max(200),
  summary: z.string().max(500).default(""),
  user_id: z.string().max(120).nullable().optional(),
  latency_ms: z.number().int().nonnegative().nullable().optional(),
  payload: z.unknown(),
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
});

/**
 * Public, key-authenticated run creation. Requires the "predict" scope.
 * Lets customers post their own runs (from a notebook, an external job,
 * or another service) and have them appear in /history immediately.
 *
 *   curl -X POST http://localhost:3000/v1/runs \
 *     -H "authorization: Bearer adh_..." \
 *     -H "content-type: application/json" \
 *     -d '{"kind":"predict","title":"batch 42","payload":{"risk":0.31}}'
 */
export async function POST(req: NextRequest) {
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

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "validation_failed", errors: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const rec: RunRecord = {
    id: newRunId(),
    created_at: Date.now(),
    kind: parsed.data.kind,
    title: parsed.data.title,
    summary: parsed.data.summary ?? "",
    user_id: parsed.data.user_id ?? null,
    latency_ms: parsed.data.latency_ms ?? null,
    payload: parsed.data.payload,
    tags: parsed.data.tags ?? [],
  };
  await appendRun(rec);

  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "POST",
    path: "/v1/runs",
    status: 201,
    latency_ms: 0,
  }).catch(() => {});

  return NextResponse.json(
    {
      id: rec.id,
      created_at: rec.created_at,
      kind: rec.kind,
      title: rec.title,
      url: `/history/${rec.id}`,
    },
    { status: 201 },
  );
}
