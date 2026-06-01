import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NameSchema = z.string().min(1).max(128);

const RegisterSchema = z.object({
  name: NameSchema,
  purpose: z.string().min(1).max(512),
  data_categories: z.string().min(1).max(512),
  region: z.string().min(1).max(128),
  url: z.string().max(512).optional().nullable(),
  summary: z.string().max(2048).optional().nullable(),
  effective_at: z.string().optional().nullable(),
});

function bubble(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      typeof err.body === "object" && err.body !== null ? err.body : { detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { detail: err instanceof Error ? err.message : "upstream error" },
    { status: 502 },
  );
}

function fwd(req: NextRequest): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" };
  const rid = req.headers.get("x-request-id");
  if (rid) h["x-request-id"] = rid;
  return h;
}

export async function GET(req: NextRequest) {
  try {
    const qs = req.nextUrl.searchParams.toString();
    const data = await apiFetch(
      `/v1/subprocessors${qs ? `?${qs}` : ""}`,
      { headers: fwd(req) },
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: "invalid json" }, { status: 400 }); }
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch(`/v1/subprocessors`, {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: fwd(req),
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
