/**
 * Public, key-authenticated batch scoring endpoint.
 *
 *   curl -X POST 'http://localhost:3000/v1/batch?format=csv' \
 *     -H 'authorization: Bearer adh_...' \
 *     -H 'content-type: text/csv' \
 *     --data-binary @schedule.csv
 *
 *   curl -X POST 'http://localhost:3000/v1/batch' \
 *     -H 'authorization: Bearer adh_...' \
 *     -H 'content-type: application/json' \
 *     -d '{"csv":"user_id,dose_id,scheduled_at,dose_class,dose_strength_mg\nu_1,d_1,2025-01-01T08:00:00Z,statin,20","top_k":3}'
 *
 * Required CSV columns: user_id, dose_id, scheduled_at, dose_class, dose_strength_mg.
 * Quota: each row consumes one prediction from the daily quota. If the batch
 * would exceed the quota the request is rejected with 429 before any upstream
 * call. Each successful batch is recorded once in /history under the API key.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, apiFetch } from "@/lib/api";
import { extractKey, hasScope, verifyKey } from "@/lib/api-keys-store";
import { parseCsv, toCsv } from "@/lib/csv";
import { appendRun, newRunId } from "@/lib/runs-store";
import { FREE_DAILY_QUOTA, recordUsage, usedToday } from "@/lib/usage-store";
import { dailyQuota as planDailyQuota } from "@/lib/plan-store";
import type { PredictResponse, DoseClass } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 512 * 1024; // 512 KB
const MAX_ROWS = 1000;
const MAX_USERS = 100;
const REQUIRED = ["user_id", "dose_id", "scheduled_at", "dose_class", "dose_strength_mg"] as const;

const DOSE_CLASSES: DoseClass[] = [
  "cardio",
  "neuro",
  "endocrine",
  "psych",
  "antibiotic",
  "supplement",
  "other",
];

const RowSchema = z.object({
  user_id: z.string().min(1).max(128),
  dose_id: z.string().min(1).max(64),
  scheduled_at: z.string().min(1).max(64),
  dose_class: z.enum(DOSE_CLASSES as [DoseClass, ...DoseClass[]]),
  dose_strength_mg: z.number().finite().nonnegative(),
});
type Row = z.infer<typeof RowSchema>;

const JsonBody = z.object({
  csv: z.string().min(1),
  top_k: z.number().int().min(0).max(50).optional(),
});

interface BatchOutRow {
  user_id: string;
  dose_id: string;
  scheduled_at: string;
  dose_class: string;
  miss_probability: number;
  risk_tier: string;
  top_reason: string;
  model_version: string;
}

interface BatchSummary {
  users: number;
  rows: number;
  predictions: number;
  high_risk: number;
  mean_miss_probability: number;
  latency_ms: number;
}

function err(status: number, error: string, detail: unknown, extra?: Record<string, string>) {
  return NextResponse.json({ error, detail }, { status, headers: extra });
}

export async function POST(req: NextRequest) {
  // --- Auth ----------------------------------------------------------------
  const presented = extractKey(req.headers);
  if (!presented) {
    return err(401, "missing_api_key", "send Authorization: Bearer <key> or x-api-key: <key>");
  }
  const key = await verifyKey(presented);
  if (!key) {
    return err(401, "invalid_api_key", "key is unknown or has been revoked");
  }
  if (!hasScope(key, "predict")) {
    return NextResponse.json(
      {
        error: "missing_scope",
        detail: "this key is missing the 'predict' scope",
        required_scope: "predict",
        key_scopes: key.scopes ?? [],
      },
      { status: 403 },
    );
  }

  // --- Parse payload -------------------------------------------------------
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  const topKParam = Number(url.searchParams.get("top_k") ?? "");
  let csvText = "";
  let topK = Number.isFinite(topKParam) && topKParam >= 0 ? Math.min(50, Math.floor(topKParam)) : 0;

  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return err(413, "payload_too_large", { limit_bytes: MAX_BYTES, got_bytes: raw.length });
  }

  if (ctype.includes("application/json")) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return err(400, "invalid_json", "request body must be JSON");
    }
    const parsed = JsonBody.safeParse(json);
    if (!parsed.success) {
      return err(422, "invalid_payload", parsed.error.flatten());
    }
    csvText = parsed.data.csv;
    if (parsed.data.top_k !== undefined) topK = parsed.data.top_k;
  } else {
    csvText = raw;
  }

  if (!csvText.trim()) {
    return err(400, "empty_csv", "no CSV content");
  }

  const { header, rows } = parseCsv(csvText);
  if (header.length === 0) {
    return err(400, "empty_csv", "no header row");
  }
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return err(422, "missing_columns", { required: REQUIRED, missing });
  }
  if (rows.length === 0) {
    return err(400, "no_rows", "header present but no data rows");
  }
  if (rows.length > MAX_ROWS) {
    return err(413, "too_many_rows", { limit: MAX_ROWS, got: rows.length });
  }

  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  const parsedRows: Row[] = [];
  const rowErrors: Array<{ line: number; error: unknown }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const obj = {
      user_id: r[idx.user_id]?.trim(),
      dose_id: r[idx.dose_id]?.trim(),
      scheduled_at: r[idx.scheduled_at]?.trim(),
      dose_class: r[idx.dose_class]?.trim(),
      dose_strength_mg: Number(r[idx.dose_strength_mg]),
    };
    const p = RowSchema.safeParse(obj);
    if (!p.success) {
      rowErrors.push({ line: i + 2, error: p.error.flatten() });
      continue;
    }
    parsedRows.push(p.data);
  }
  if (rowErrors.length > 0) {
    return err(422, "row_validation_failed", {
      count: rowErrors.length,
      errors: rowErrors.slice(0, 10),
    });
  }

  // Group rows by user.
  const byUser = new Map<string, Row[]>();
  for (const r of parsedRows) {
    const list = byUser.get(r.user_id);
    if (list) list.push(r);
    else byUser.set(r.user_id, [r]);
  }
  if (byUser.size > MAX_USERS) {
    return err(413, "too_many_users", { limit: MAX_USERS, got: byUser.size });
  }

  // --- Quota check (all-or-nothing) ----------------------------------------
  const used = await usedToday();
  const quota = await planDailyQuota().catch(() => FREE_DAILY_QUOTA);
  const cost = parsedRows.length;
  if (used + cost > quota) {
    return NextResponse.json(
      {
        error: "quota_exceeded",
        detail: "this batch would exceed the daily plan quota",
        quota,
        used_today: used,
        batch_cost: cost,
        remaining: Math.max(0, quota - used),
        upgrade_url: "/pricing",
      },
      {
        status: 429,
        headers: {
          "x-quota-limit": String(quota),
          "x-quota-used": String(used),
          "x-quota-remaining": String(Math.max(0, quota - used)),
          "retry-after": "3600",
        },
      },
    );
  }

  // --- Score ---------------------------------------------------------------
  const t0 = Date.now();
  const outRows: BatchOutRow[] = [];
  const perUser: Array<{ user_id: string; predictions: number; model_version: string }> = [];
  let high = 0;
  let probSum = 0;
  let predCount = 0;

  for (const [user_id, userRows] of byUser) {
    const body = {
      user_id,
      top_k_reasons: topK > 0 ? topK : 3,
      schedule: userRows.map((r) => ({
        dose_id: r.dose_id,
        scheduled_at: r.scheduled_at,
        dose_class: r.dose_class,
        dose_strength_mg: r.dose_strength_mg,
      })),
    };
    let resp: PredictResponse;
    try {
      resp = await apiFetch<PredictResponse>("/v1/predict", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      if (e instanceof ApiError) {
        return err(e.status, "upstream_error", { user_id, body: e.body });
      }
      return err(502, "upstream_unavailable", {
        user_id,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    perUser.push({
      user_id,
      predictions: resp.predictions.length,
      model_version: resp.model_version,
    });
    for (const p of resp.predictions) {
      const topReason = p.reasons.length > 0 ? p.reasons[0].human : "";
      outRows.push({
        user_id: resp.user_id,
        dose_id: p.dose_id,
        scheduled_at: p.scheduled_at,
        dose_class: p.dose_class ?? "",
        miss_probability: Number(p.miss_probability.toFixed(4)),
        risk_tier: p.risk_tier,
        top_reason: topReason,
        model_version: resp.model_version,
      });
      probSum += p.miss_probability;
      predCount += 1;
      if (p.risk_tier === "high") high += 1;
    }
  }

  const latency = Date.now() - t0;
  const summary: BatchSummary = {
    users: byUser.size,
    rows: parsedRows.length,
    predictions: predCount,
    high_risk: high,
    mean_miss_probability: predCount === 0 ? 0 : Number((probSum / predCount).toFixed(4)),
    latency_ms: latency,
  };

  // --- Bookkeeping (best-effort) -------------------------------------------
  try {
    await appendRun({
      id: newRunId(),
      created_at: Date.now(),
      kind: "other",
      title: `v1 batch: ${summary.predictions} predictions, ${summary.users} users`,
      summary: `${summary.high_risk} high risk, mean miss ${(summary.mean_miss_probability * 100).toFixed(1)}%`,
      user_id: null,
      latency_ms: latency,
      payload: {
        via: "v1",
        key_id: key.id,
        summary,
        per_user: perUser,
        top_k: topK,
        // keep payload bounded
        rows: outRows.slice(0, 200),
      },
      tags: ["v1", "batch", `key:${key.prefix}`],
    });
  } catch {
    // bookkeeping must never break the call
  }

  try {
    // Record one usage event per row so meters & sparklines stay accurate.
    const now = Date.now();
    for (let i = 0; i < parsedRows.length; i++) {
      await recordUsage({
        ts: now,
        key_id: key.id,
        key_prefix: key.prefix,
        status: 200,
        latency_ms: i === 0 ? latency : 0,
      });
    }
  } catch {
    // bookkeeping must never break the call
  }

  const remaining = Math.max(0, quota - used - cost);
  const quotaHeaders: Record<string, string> = {
    "x-quota-limit": String(quota),
    "x-quota-used": String(used + cost),
    "x-quota-remaining": String(remaining),
    "x-batch-rows": String(outRows.length),
    "x-batch-users": String(byUser.size),
    "x-latency-ms": String(latency),
  };

  if (format === "csv") {
    const csv = toCsv(
      [
        "user_id",
        "dose_id",
        "scheduled_at",
        "dose_class",
        "miss_probability",
        "risk_tier",
        "top_reason",
        "model_version",
      ],
      outRows.map((o) => [
        o.user_id,
        o.dose_id,
        o.scheduled_at,
        o.dose_class,
        o.miss_probability,
        o.risk_tier,
        o.top_reason,
        o.model_version,
      ]),
    );
    return new NextResponse(csv, {
      status: 200,
      headers: {
        ...quotaHeaders,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="adherence-batch-${Date.now()}.csv"`,
      },
    });
  }

  return NextResponse.json(
    { summary, per_user: perUser, rows: outRows },
    { headers: quotaHeaders },
  );
}

export function GET() {
  return NextResponse.json({
    endpoint: "/v1/batch",
    method: "POST",
    auth: "Authorization: Bearer <key>  or  x-api-key: <key>  (requires 'predict' scope)",
    accepts: ["text/csv", "application/json"],
    required_columns: REQUIRED,
    query_params: {
      format: "json | csv (default json)",
      top_k: "integer 0..50, number of reason codes per dose",
    },
    limits: { max_bytes: MAX_BYTES, max_rows: MAX_ROWS, max_users: MAX_USERS },
    quota: "each input row counts as one prediction against the daily plan quota",
    example_csv:
      "user_id,dose_id,scheduled_at,dose_class,dose_strength_mg\nu_1,d_1,2025-01-01T08:00:00Z,statin,20",
  });
}
