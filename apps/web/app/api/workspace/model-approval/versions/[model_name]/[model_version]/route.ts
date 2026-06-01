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

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ model_name: string; model_version: string }> },
) {
  const { model_name, model_version } = await ctx.params;
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry_run");
    const qs = dry ? `?dry_run=${encodeURIComponent(dry)}` : "";
    const path = `/v1/workspace/model-approval/versions/${encodeURIComponent(model_name)}/${encodeURIComponent(model_version)}${qs}`;
    const data = await apiFetch(path, {
      method: "DELETE",
      headers: fwdHeaders(req),
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
