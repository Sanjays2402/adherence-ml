import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, apiFetch } from "@/lib/api";
import { parseCsv, toCsv } from "@/lib/csv";
import type { PredictResponse, DoseClass } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 256 * 1024; // 256 KB
const MAX_ROWS = 500;
const MAX_USERS = 50;
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

function err(status: number, error: string, detail: unknown) {
  return NextResponse.json({ error, detail }, { status });
}

export async function POST(req: NextRequest) {
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  const format = (req.nextUrl.searchParams.get("format") ?? "json").toLowerCase();
  const topKParam = Number(req.nextUrl.searchParams.get("top_k") ?? "");
  let csvText = "";
  let topK = Number.isFinite(topKParam) && topKParam >= 0 ? Math.min(50, Math.floor(topKParam)) : 0;

  // Cap payload defensively.
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
    // text/csv or anything else: treat as raw CSV
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
    return err(422, "row_validation_failed", { count: rowErrors.length, errors: rowErrors.slice(0, 10) });
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

  const summary: BatchSummary = {
    users: byUser.size,
    rows: parsedRows.length,
    predictions: predCount,
    high_risk: high,
    mean_miss_probability: predCount === 0 ? 0 : Number((probSum / predCount).toFixed(4)),
    latency_ms: Date.now() - t0,
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
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="adherence-batch-${Date.now()}.csv"`,
        "x-batch-rows": String(outRows.length),
        "x-batch-users": String(byUser.size),
      },
    });
  }

  return NextResponse.json({
    summary,
    per_user: perUser,
    rows: outRows,
  });
}

export function GET() {
  return NextResponse.json({
    detail:
      "POST a CSV body (content-type: text/csv) or JSON {csv, top_k}. Required columns: " +
      REQUIRED.join(", ") +
      ". Add ?format=csv for a CSV download.",
    limits: { max_bytes: MAX_BYTES, max_rows: MAX_ROWS, max_users: MAX_USERS },
  });
}
