import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Backend bounds (mirrors adherence_common.session_policy):
// MIN_MAX_AGE_SECONDS = 5 * 60     // 5 minutes
// MAX_MAX_AGE_SECONDS = 30 * 24 * 60 * 60  // 30 days
const MIN_SEC = 5 * 60;
const MAX_SEC = 30 * 24 * 60 * 60;

const PutSchema = z.object({
  max_age_seconds: z.number().int().min(MIN_SEC).max(MAX_SEC),
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
    const dry = url.searchParams.get("dry_run");
    const qs = dry ? `?dry_run=${encodeURIComponent(dry)}` : "";
    const data = await apiFetch(`/v1/workspace/session-policy${qs}`, {
      headers: fwdHeaders(req),
    });
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
  const parsed = PutSchema.safeParse(body);
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
    const data = await apiFetch(`/v1/workspace/session-policy${qs}`, {
      method: "PUT",
      body: JSON.stringify(parsed.data),
      headers: fwdHeaders(req),
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dry = url.searchParams.get("dry_run");
    const qs = dry ? `?dry_run=${encodeURIComponent(dry)}` : "";
    const data = await apiFetch(`/v1/workspace/session-policy${qs}`, {
      method: "DELETE",
      headers: fwdHeaders(req),
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
