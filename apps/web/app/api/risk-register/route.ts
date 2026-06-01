import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CATEGORIES = [
  "security",
  "privacy",
  "availability",
  "integrity",
  "confidentiality",
  "compliance",
  "operational",
  "financial",
  "vendor",
  "model",
  "other",
] as const;

const TREATMENTS = ["accept", "mitigate", "transfer", "avoid"] as const;

const STATUSES = [
  "open",
  "mitigating",
  "accepted",
  "monitoring",
  "closed",
] as const;

const CreateSchema = z.object({
  title: z.string().min(3).max(128),
  category: z.enum(CATEGORIES),
  description: z.string().min(10).max(4096),
  asset: z.string().max(256).nullish(),
  likelihood: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  mitigations: z.string().max(4096).nullish(),
  residual_likelihood: z.number().int().min(1).max(5).nullish(),
  residual_impact: z.number().int().min(1).max(5).nullish(),
  treatment: z.enum(TREATMENTS),
  owner: z.string().min(1).max(128),
  status: z.enum(STATUSES).nullish(),
  identified_at: z.string().max(64).nullish(),
  next_review_at: z.string().max(64).nullish(),
  notes: z.string().max(2048).nullish(),
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
  const sp = req.nextUrl.searchParams;
  const include = sp.get("include_closed") ?? "false";
  const category = sp.get("category") ?? "";
  const qs = new URLSearchParams();
  qs.set("include_closed", include);
  if (category) qs.set("category", category);
  try {
    const data = await apiFetch(`/v1/admin/risk-register?${qs.toString()}`);
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
    const data = await apiFetch("/v1/admin/risk-register", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
