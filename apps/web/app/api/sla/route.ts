import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CreateSchema = z.object({
  contract_ref: z.string().min(2).max(128),
  plan: z.string().min(1).max(64).optional(),
  uptime_pct: z.number().min(50).max(100),
  sev1_response_hours: z.number().min(0.05).max(720),
  sev2_response_hours: z.number().min(0.05).max(720),
  sev3_response_hours: z.number().min(0.05).max(720),
  sev4_response_hours: z.number().min(0.05).max(720),
  rto_minutes: z.number().int().min(0).max(60 * 24 * 30),
  rpo_minutes: z.number().int().min(0).max(60 * 24 * 30),
  effective_from: z.string().min(8).max(64),
  effective_until: z.string().min(8).max(64).nullish(),
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
      `/v1/admin/sla?include_archived=${encodeURIComponent(include)}`,
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
    const data = await apiFetch("/v1/admin/sla", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
