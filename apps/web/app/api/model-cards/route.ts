import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Sensitivity = z.enum(["none", "low", "medium", "high", "phi"]);
const Fairness = z.enum([
  "not_assessed",
  "in_progress",
  "assessed",
  "remediation",
]);

const CreateSchema = z.object({
  model_name: z.string().min(2).max(128),
  model_version: z.string().min(1).max(64),
  owner: z.string().min(1).max(128),
  intended_use: z.string().max(4096).nullish(),
  training_data_summary: z.string().max(4096).nullish(),
  training_data_sensitivity: Sensitivity.default("none"),
  evaluation_summary: z.string().max(4096).nullish(),
  limitations: z.string().max(4096).nullish(),
  phi_suitable: z.boolean().default(false),
  fairness_status: Fairness.default("not_assessed"),
  last_validated_at: z.string().max(64).nullish(),
  model_card_url: z.string().max(512).nullish(),
  notes: z.string().max(4096).nullish(),
  supersede_reason: z.string().max(256).nullish(),
});

function bubble(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      typeof err.body === "object" && err.body !== null
        ? err.body
        : { detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { detail: err instanceof Error ? err.message : "upstream error" },
    { status: 502 },
  );
}

export async function GET(req: NextRequest) {
  const include = req.nextUrl.searchParams.get("include_archived") ?? "false";
  try {
    const data = await apiFetch(
      `/v1/admin/model-cards?include_archived=${encodeURIComponent(include)}`,
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch("/v1/admin/model-cards", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
