/**
 * Public, key-authenticated dashboard audit log endpoint.
 *
 * Streams the hash-chained dashboard audit log (settings changes,
 * exports, role mutations, account erasure, key rotations, etc.) so a
 * customer's SIEM (Splunk, Datadog, Elastic, Panther) can pull it on a
 * schedule instead of scraping the dashboard UI. SOC2 reviewers ask for
 * this on day one.
 *
 *   curl "http://localhost:3000/v1/audit?format=ndjson&limit=500" \
 *     -H "authorization: Bearer adh_..."
 *
 * Requires the `audit` scope. Read-only; does not consume predict
 * quota; does not write to the audit log itself (read access is not a
 * compliance event). Cross-tenant: this endpoint returns only entries
 * for the workspace the calling key belongs to, scoped by the same
 * dashboard-audit store the /audit page reads.
 *
 * Query params:
 *   format   = json (default) | ndjson | jsonl | csv
 *   limit    = 1..1000 (default 100)
 *   action   = exact-match filter on the `action` field
 *   actor    = exact-match filter on `actor_user_id`
 *   outcome  = success | failure | denied
 *   since    = ISO-8601 timestamp or epoch ms; only newer entries
 *
 * Response headers always include the standard rate-limit triple plus
 * `X-Audit-Tip-Hash` (the latest chain hash) and `X-Audit-Chain-Valid`
 * so a SIEM can alert on tampering without parsing the body.
 */
import { NextRequest, NextResponse } from "next/server";
import { extractKey, hasScope, scopesOf, verifyKey } from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { summary } from "@/lib/usage-store";
import {
  listAudit,
  type AuditEntry,
  type AuditOutcome,
} from "@/lib/dashboard-audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FORMATS = new Set(["json", "ndjson", "jsonl", "csv"]);

function nextUtcMidnightSec(): number {
  const now = new Date();
  return Math.floor(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
    ) / 1000,
  );
}

function parseSince(raw: string | null): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: AuditEntry[]): string {
  const head = [
    "id",
    "ts_iso",
    "actor_user_id",
    "actor_email",
    "action",
    "target",
    "outcome",
    "ip",
    "user_agent",
    "metadata",
    "prev_hash",
    "hash",
  ];
  const out = [head.join(",")];
  for (const e of rows) {
    out.push(
      [
        e.id,
        new Date(e.ts).toISOString(),
        csvEscape(e.actor_user_id),
        csvEscape(e.actor_email),
        csvEscape(e.action),
        csvEscape(e.target),
        e.outcome,
        csvEscape(e.ip),
        csvEscape(e.user_agent),
        csvEscape(e.metadata),
        e.prev_hash,
        e.hash,
      ].join(","),
    );
  }
  return out.join("\n") + "\n";
}

function rateLimitHeaders(
  quota: number,
  remaining: number,
): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(quota),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(nextUtcMidnightSec()),
  };
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const presented = extractKey(req.headers);
  if (!presented) {
    return NextResponse.json(
      {
        detail:
          "missing api key. send Authorization: Bearer <key> or x-api-key: <key>",
      },
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
  const scopes = scopesOf(key);
  if (!hasScope(key, "audit")) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "GET",
      path: "/v1/audit",
      status: 403,
      latency_ms: Date.now() - t0,
    }).catch(() => {});
    return NextResponse.json(
      {
        detail:
          "this api key is missing the 'audit' scope. mint a new key with 'audit' to read the dashboard audit log.",
        key_scopes: scopes,
        required_scope: "audit",
      },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  if (!FORMATS.has(format)) {
    return NextResponse.json(
      {
        detail: `unsupported format '${format}'. supported: json, ndjson, jsonl, csv`,
        supported_formats: [...FORMATS],
      },
      { status: 400 },
    );
  }

  const limitRaw = url.searchParams.get("limit");
  let limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
  if (!Number.isFinite(limit)) limit = 100;
  limit = Math.min(Math.max(limit, 1), 1000);

  const outcomeRaw = url.searchParams.get("outcome");
  const outcome: AuditOutcome | undefined =
    outcomeRaw === "success" || outcomeRaw === "failure" || outcomeRaw === "denied"
      ? outcomeRaw
      : undefined;

  const result = await listAudit({
    limit,
    action: url.searchParams.get("action") ?? undefined,
    actor_user_id: url.searchParams.get("actor") ?? undefined,
    outcome,
    since_ms: parseSince(url.searchParams.get("since")),
  });

  const s = await summary().catch(() => null);
  const headers: Record<string, string> = {
    "X-Audit-Tip-Hash": result.tip_hash ?? "",
    "X-Audit-Chain-Valid": result.chain_valid ? "true" : "false",
    "Cache-Control": "no-store",
    ...(s ? rateLimitHeaders(s.quota, s.remaining_today) : {}),
  };

  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "GET",
    path: "/v1/audit",
    status: 200,
    latency_ms: Date.now() - t0,
  }).catch(() => {});

  if (format === "ndjson" || format === "jsonl") {
    const body = result.items.map((e) => JSON.stringify(e)).join("\n");
    return new NextResponse(body + (body.length > 0 ? "\n" : ""), {
      status: 200,
      headers: {
        ...headers,
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="dashboard-audit-${new Date()
          .toISOString()
          .slice(0, 10)}.jsonl"`,
      },
    });
  }

  if (format === "csv") {
    return new NextResponse(toCsv(result.items), {
      status: 200,
      headers: {
        ...headers,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="dashboard-audit-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json(
    {
      items: result.items,
      total: result.total,
      chain_valid: result.chain_valid,
      tip_hash: result.tip_hash,
      returned: result.items.length,
      limit,
    },
    { status: 200, headers },
  );
}
