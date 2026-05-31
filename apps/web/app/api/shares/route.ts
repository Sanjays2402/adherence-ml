import { NextResponse } from "next/server";
import { z } from "zod";

import { createShare, type ShareRecord } from "@/lib/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RowSchema = z.object({
  dose_id: z.string().min(1).max(64),
  scheduled_at: z.string().min(1).max(64),
  dose_class: z.string().min(1).max(32),
  dose_strength_mg: z.number().finite(),
});

const ReasonSchema = z.object({
  feature: z.string(),
  contribution: z.number(),
  human: z.string(),
});

const PredictionSchema = z.object({
  dose_id: z.string(),
  scheduled_at: z.string(),
  miss_probability: z.number(),
  risk_tier: z.enum(["low", "medium", "high"]),
  reasons: z.array(ReasonSchema),
  dose_class: z
    .enum(["cardio", "neuro", "endocrine", "psych", "antibiotic", "supplement", "other"])
    .optional(),
});

const ResultSchema = z.object({
  user_id: z.string(),
  model_version: z.string(),
  predictions: z.array(PredictionSchema).max(500),
});

const Body = z.object({
  user_id: z.string().min(1).max(128),
  top_k: z.number().int().min(0).max(50),
  rows: z.array(RowSchema).min(1).max(200),
  result: ResultSchema,
  latency_ms: z.number().int().nonnegative().nullable().optional(),
  title: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body must be JSON" },
      { status: 400 },
    );
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const record = await createShare({
    user_id: parsed.data.user_id,
    top_k: parsed.data.top_k,
    rows: parsed.data.rows,
    result: parsed.data.result as ShareRecord["result"],
    latency_ms: parsed.data.latency_ms ?? null,
    title: parsed.data.title,
  });
  return NextResponse.json(
    { id: record.id, url: `/r/${record.id}`, created_at: record.created_at },
    { status: 201 },
  );
}
