import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Mirrors adherence_common.password_policy bounds.
const MIN_LENGTH_FLOOR = 8;
const MIN_LENGTH_CEILING = 128;
const MAX_AGE_DAYS_CEILING = 365 * 2;
const HISTORY_CEILING = 24;

const PutSchema = z.object({
  min_length: z.number().int().min(MIN_LENGTH_FLOOR).max(MIN_LENGTH_CEILING),
  require_upper: z.boolean(),
  require_lower: z.boolean(),
  require_digit: z.boolean(),
  require_symbol: z.boolean(),
  max_age_days: z.number().int().min(0).max(MAX_AGE_DAYS_CEILING),
  history_size: z.number().int().min(0).max(HISTORY_CEILING),
});

const CheckSchema = z.object({
  password: z.string().min(1).max(512),
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

function qs(req: NextRequest): string {
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry_run");
  return dry ? `?dry_run=${encodeURIComponent(dry)}` : "";
}

export async function GET(req: NextRequest) {
  try {
    const data = await apiFetch(`/v1/workspace/password-policy${qs(req)}`, {
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
    const data = await apiFetch(`/v1/workspace/password-policy${qs(req)}`, {
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
    const data = await apiFetch(`/v1/workspace/password-policy${qs(req)}`, {
      method: "DELETE",
      headers: fwdHeaders(req),
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

// Sub-route handled in ./check/route.ts; but we also support POST here for
// convenience when callers prefer one URL with an action verb in the body.
export { PutSchema as _PutSchema, CheckSchema as _CheckSchema };
