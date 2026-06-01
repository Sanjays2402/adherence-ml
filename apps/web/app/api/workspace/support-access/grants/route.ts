import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Mirrors backend bounds in adherence_common.support_access.
const MIN_TTL = 60;
const MAX_TTL = 60 * 60 * 24 * 30;

const PostSchema = z.object({
  reason: z.string().min(10).max(1000),
  ttl_seconds: z.number().int().min(MIN_TTL).max(MAX_TTL),
  grantee_sub: z.string().max(128).optional().nullable(),
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
    const url = new URL(req.url);
    const inc = url.searchParams.get("include_inactive");
    const qs = inc ? `?include_inactive=${encodeURIComponent(inc)}` : "";
    const data = await apiFetch(`/v1/workspace/support-access/grants${qs}`, {
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
    const payload: Record<string, unknown> = {
      reason: parsed.data.reason,
      ttl_seconds: parsed.data.ttl_seconds,
    };
    if (parsed.data.grantee_sub) payload.grantee_sub = parsed.data.grantee_sub;
    const data = await apiFetch(`/v1/workspace/support-access/grants${qs}`, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: fwdHeaders(req),
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
