import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RISK_RATINGS = ["low", "moderate", "high"] as const;

const CreateSchema = z.object({
  title: z.string().min(3).max(128),
  description: z.string().min(10).max(4096),
  residual_risk: z.enum(RISK_RATINGS),
  necessity: z.string().max(4096).nullish(),
  risks: z.string().max(4096).nullish(),
  mitigations: z.string().max(4096).nullish(),
  dpo_consulted: z.boolean().optional(),
  consultation_required: z.boolean().optional(),
  review_in_days: z.number().int().min(30).max(1095).nullish(),
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
      `/v1/admin/dpia?include_archived=${encodeURIComponent(include)}`,
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
    const data = await apiFetch("/v1/admin/dpia", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
