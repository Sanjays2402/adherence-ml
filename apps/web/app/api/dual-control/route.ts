import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTION_TYPE = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9._-]+$/, "lowercase letters, digits, '.', '_' or '-' only");

const RequestCreateSchema = z.object({
  action_type: ACTION_TYPE,
  payload: z.any(),
  reason: z.string().min(10).max(4096),
  summary: z.string().max(256).nullish(),
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

export async function GET(req: NextRequest) {
  const params = new URLSearchParams();
  const statuses = req.nextUrl.searchParams.getAll("statuses");
  for (const s of statuses) params.append("statuses", s);
  const action = req.nextUrl.searchParams.get("action_type");
  if (action) params.set("action_type", action);
  try {
    const qs = params.toString();
    const data = await apiFetch(
      `/v1/admin/dual-control${qs ? `?${qs}` : ""}`,
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
  const parsed = RequestCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch("/v1/admin/dual-control", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
