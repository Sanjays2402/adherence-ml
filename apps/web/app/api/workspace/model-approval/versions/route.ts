import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PostSchema = z.object({
  model_name: z.string().min(1).max(128),
  model_version: z.string().min(1).max(64),
  note: z.string().max(4096).optional().nullable(),
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

function fwdHeaders(req: NextRequest): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" };
  const rid = req.headers.get("x-request-id");
  if (rid) h["x-request-id"] = rid;
  const mfa = req.headers.get("x-mfa-code");
  if (mfa) h["X-MFA-Code"] = mfa;
  return h;
}

export async function GET(req: NextRequest) {
  try {
    const data = await apiFetch(`/v1/workspace/model-approval/versions`, {
      headers: fwdHeaders(req),
    });
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
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry_run");
    const qs = dry ? `?dry_run=${encodeURIComponent(dry)}` : "";
    const data = await apiFetch(
      `/v1/workspace/model-approval/versions${qs}`,
      {
        method: "POST",
        body: JSON.stringify(parsed.data),
        headers: fwdHeaders(req),
      },
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
