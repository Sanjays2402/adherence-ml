import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ public_id: string }> },
) {
  const { public_id } = await ctx.params;
  if (!public_id || !/^sag_[A-Za-z0-9_-]{1,36}$/.test(public_id)) {
    return NextResponse.json(
      { detail: "invalid grant id" },
      { status: 400 },
    );
  }
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry_run");
    const qs = dry ? `?dry_run=${encodeURIComponent(dry)}` : "";
    const data = await apiFetch(
      `/v1/workspace/support-access/grants/${encodeURIComponent(public_id)}/revoke${qs}`,
      {
        method: "POST",
        headers: fwdHeaders(req),
      },
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
