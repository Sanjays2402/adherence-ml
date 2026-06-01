import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TtlMap = z.record(z.string().min(1).max(64), z.number().int().min(1).max(3650));

const PutSchema = z.object({
  ttls_days: TtlMap.refine((m) => Object.keys(m).length > 0, {
    message: "ttls_days must contain at least one entry",
  }),
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

export async function GET() {
  try {
    const data = await apiFetch("/v1/workspace/retention-policy");
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
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";
  try {
    const data = await apiFetch(
      `/v1/workspace/retention-policy${dryRun ? "?dry_run=true" : ""}`,
      {
        method: "PUT",
        body: JSON.stringify(parsed.data),
        headers: { "content-type": "application/json" },
      },
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function DELETE(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";
  try {
    const data = await apiFetch(
      `/v1/workspace/retention-policy${dryRun ? "?dry_run=true" : ""}`,
      { method: "DELETE" },
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
