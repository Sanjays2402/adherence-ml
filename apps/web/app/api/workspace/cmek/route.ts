import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_PROVIDERS = [
  "aws_kms",
  "gcp_kms",
  "azure_keyvault",
  "hashicorp_vault",
  "other",
] as const;

const ALLOWED_STATES = ["pending", "active", "retired"] as const;

const PutSchema = z.object({
  provider: z.enum(ALLOWED_PROVIDERS),
  key_reference: z.string().min(1).max(512),
  rotation_period_days: z.number().int().min(1).max(365 * 5),
  state: z.enum(ALLOWED_STATES),
  description: z.string().max(512).optional().nullable(),
  contact: z.string().max(256).optional().nullable(),
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
    const data = await apiFetch(`/v1/workspace/cmek${qs(req)}`, {
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
    const data = await apiFetch(`/v1/workspace/cmek${qs(req)}`, {
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
    const data = await apiFetch(`/v1/workspace/cmek${qs(req)}`, {
      method: "DELETE",
      headers: fwdHeaders(req),
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
