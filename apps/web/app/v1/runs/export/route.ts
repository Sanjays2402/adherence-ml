/**
 * Public, key-authenticated runs export endpoint.
 *
 * Stream the same CSV / JSON / NDJSON the /history page exports, but
 * driven by an API key so customers can wire it into cron, Sheets, or a
 * BI pipeline. Requires the "read" scope.
 *
 *   curl -L "http://localhost:3000/v1/runs/export?format=csv&kind=predict" \
 *     -H "authorization: Bearer adh_..." -o runs.csv
 *
 * Supported query params:
 *   format = json (default) | csv | ndjson | jsonl
 *   kind   = all | predict | demo | explain | cohort | forecast | other
 *   q      = free-text search across title / summary / tags / user_id
 *   tag    = repeatable, or `tags=a,b,c` for AND-match
 *   from   = YYYY-MM-DD or ISO (inclusive)
 *   to     = YYYY-MM-DD or ISO (inclusive, end-of-day for bare dates)
 *   limit  = 1..10000 (default 1000)
 *
 * Returns the same slim, scope-safe shape /v1/runs uses; never leaks
 * other tenants' raw payloads.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { extractKey, hasScope, verifyKey } from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { listAllRuns, type RunKind, type RunRecord } from "@/lib/runs-store";
import { filterRunsForExport, type ExportFilters } from "@/lib/runs-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KINDS = ["all", "predict", "demo", "explain", "cohort", "forecast", "other"] as const;
const FORMATS = ["json", "csv", "ndjson", "jsonl"] as const;
type Format = (typeof FORMATS)[number];

const QuerySchema = z.object({
  format: z.enum(FORMATS).default("json"),
  kind: z.enum(KINDS).default("all"),
  q: z.string().max(200).optional(),
  tag: z.array(z.string().max(40)).max(20).default([]),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(10_000).default(1000),
});

function parseDate(raw: string | undefined, endOfDay: boolean): number | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = Date.parse(raw + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"));
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

interface SlimRun {
  id: string;
  created_at: number;
  created_at_iso: string;
  kind: string;
  title: string;
  summary: string;
  user_id: string;
  latency_ms: number | null;
  tags: string[];
  shared: boolean;
}

function slim(rows: RunRecord[]): SlimRun[] {
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    created_at_iso: new Date(r.created_at).toISOString(),
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    user_id: r.user_id ?? "",
    latency_ms: r.latency_ms ?? null,
    tags: r.tags,
    shared: Boolean(r.share_token),
  }));
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: SlimRun[]): string {
  const head = [
    "id",
    "created_at_iso",
    "kind",
    "title",
    "summary",
    "user_id",
    "latency_ms",
    "tags",
    "shared",
  ];
  const out = [head.join(",")];
  for (const r of rows) {
    out.push(
      [
        r.id,
        r.created_at_iso,
        r.kind,
        csvEscape(r.title),
        csvEscape(r.summary),
        csvEscape(r.user_id),
        r.latency_ms ?? "",
        csvEscape(r.tags.join("|")),
        r.shared ? "true" : "false",
      ].join(","),
    );
  }
  return out.join("\n") + "\n";
}

function toNdjson(rows: SlimRun[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
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
  // Collect repeatable tags + comma-list `tags=a,b,c` for ergonomics.
  const tagCollected = [
    ...sp.getAll("tag"),
    ...(sp.get("tags")?.split(",") ?? []),
  ]
    .map((t) => t.trim())
    .filter(Boolean);

  const parsed = QuerySchema.safeParse({
    format: sp.get("format") ?? undefined,
    kind: sp.get("kind") ?? undefined,
    q: sp.get("q") ?? undefined,
    tag: tagCollected,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    limit: sp.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "GET",
      path: "/v1/runs/export",
      status: 422,
      latency_ms: 0,
    }).catch(() => {});
    return NextResponse.json(
      { detail: "invalid query", errors: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const { format, kind, q, tag, from, to, limit } = parsed.data;

  const filters: ExportFilters = {
    q,
    kind: kind as RunKind | "all",
    tags: tag,
    from: parseDate(from, false),
    to: parseDate(to, true),
  };

  const t0 = Date.now();
  const all = await listAllRuns();
  const filtered = filterRunsForExport(all, filters)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
  const rows = slim(filtered);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix =
    [
      kind !== "all" ? kind : null,
      tag.length ? `tag-${tag[0]}` : null,
      q ? "filtered" : null,
    ]
      .filter(Boolean)
      .join("-") || "all";

  const latency = Date.now() - t0;
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/runs/export",
    status: 200,
    latency_ms: latency,
  }).catch(() => {});

  const headers = (contentType: string, ext: string): HeadersInit => ({
    "content-type": contentType,
    "content-disposition": `attachment; filename="adherence-runs-${suffix}-${stamp}.${ext}"`,
    "x-export-count": String(rows.length),
    "x-export-truncated": filterRunsForExport(all, filters).length > limit ? "true" : "false",
    "cache-control": "no-store",
  });

  const fmt: Format = format;
  if (fmt === "csv") {
    return new NextResponse(toCsv(rows), {
      status: 200,
      headers: headers("text/csv; charset=utf-8", "csv"),
    });
  }
  if (fmt === "ndjson" || fmt === "jsonl") {
    return new NextResponse(toNdjson(rows), {
      status: 200,
      headers: headers("application/x-ndjson; charset=utf-8", "ndjson"),
    });
  }
  return new NextResponse(JSON.stringify({ count: rows.length, items: rows }, null, 2), {
    status: 200,
    headers: headers("application/json; charset=utf-8", "json"),
  });
}
