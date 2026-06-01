import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES = ["draft", "active", "expired", "terminated"] as const;

const CreateSchema = z.object({
  counterparty: z.string().min(2).max(200),
  document_version: z.string().min(1).max(64),
  status: z.enum(STATUSES).optional(),
  effective_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  breach_notify_hours: z.number().int().min(1).max(60 * 24).nullish(),
  covered_entity_signatory: z.string().max(200).nullish(),
  business_associate_signatory: z.string().max(200).nullish(),
  evidence_url: z.string().max(1024).nullish(),
  notes: z.string().max(4096).nullish(),
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
  const include = req.nextUrl.searchParams.get("include_terminated") ?? "false";
  try {
    const data = await apiFetch(
      `/v1/admin/baa?include_terminated=${encodeURIComponent(include)}`,
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
    const data = await apiFetch("/v1/admin/baa", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
