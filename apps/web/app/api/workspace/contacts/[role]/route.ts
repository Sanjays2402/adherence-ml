import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROLES = new Set([
  "security",
  "privacy",
  "billing",
  "abuse",
  "technical",
  "breach_notification",
]);

const SetSchema = z.object({
  email: z.string().min(3).max(320),
  label: z.string().max(80).nullish(),
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

function guard(role: string): NextResponse | null {
  if (!ROLES.has(role)) {
    return NextResponse.json({ detail: "unknown role" }, { status: 400 });
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ role: string }> },
) {
  const { role } = await params;
  const bad = guard(role);
  if (bad) return bad;
  try {
    const data = await apiFetch(`/v1/workspace/contacts/${role}`);
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ role: string }> },
) {
  const { role } = await params;
  const bad = guard(role);
  if (bad) return bad;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = SetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";
  const suffix = dryRun ? "?dry_run=true" : "";
  try {
    const data = await apiFetch(
      `/v1/workspace/contacts/${role}${suffix}`,
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ role: string }> },
) {
  const { role } = await params;
  const bad = guard(role);
  if (bad) return bad;
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";
  const suffix = dryRun ? "?dry_run=true" : "";
  try {
    const data = await apiFetch(
      `/v1/workspace/contacts/${role}${suffix}`,
      { method: "DELETE" },
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
