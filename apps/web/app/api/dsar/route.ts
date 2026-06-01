import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REQUEST_TYPES = [
  "access",
  "erasure",
  "rectification",
  "restriction",
  "portability",
  "objection",
  "opt_out_sale",
] as const;

const CreateSchema = z.object({
  request_type: z.enum(REQUEST_TYPES),
  subject_name: z.string().min(3).max(256),
  subject_email: z.string().email().max(320),
  description: z.string().min(10).max(8192),
  received_via: z.string().max(64).nullish(),
  external_ref: z.string().max(256).nullish(),
  store_raw_contact: z.boolean().default(false),
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
  const include = req.nextUrl.searchParams.get("include_closed") ?? "true";
  try {
    const data = await apiFetch(
      `/v1/admin/dsar?include_closed=${encodeURIComponent(include)}`,
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
    const data = await apiFetch("/v1/admin/dsar", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
