import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AckSchema = z.object({ change_id: z.number().int().min(1) });

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

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: "invalid json" }, { status: 400 }); }
  const parsed = AckSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch(`/v1/subprocessors/acknowledge`, {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: fwd(req),
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
