import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PolicyUpsertSchema = z.object({
  action_type: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/),
  description: z.string().max(4096).nullish(),
  ttl_seconds: z.number().int().min(300).max(7 * 24 * 60 * 60).nullish(),
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

export async function GET() {
  try {
    const data = await apiFetch("/v1/admin/dual-control/policy");
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = PolicyUpsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch("/v1/admin/dual-control/policy", {
      method: "PUT",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
