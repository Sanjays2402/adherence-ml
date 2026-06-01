import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UpdateSchema = z.object({
  title: z.string().min(4).max(200).nullish(),
  change_type: z.enum(["standard", "normal", "emergency"]).nullish(),
  risk_class: z.enum(["low", "medium", "high", "critical"]).nullish(),
  affected_service: z.string().min(2).max(128).nullish(),
  rollback_plan: z.string().min(4).max(4096).nullish(),
  approver_email: z.string().email().max(254).nullish(),
  notes: z.string().max(4096).nullish(),
  planned_start_at: z.string().datetime({ offset: true }).nullish(),
  planned_end_at: z.string().datetime({ offset: true }).nullish(),
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

function idOf(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const n = idOf(id);
  if (n === null) {
    return NextResponse.json({ detail: "invalid id" }, { status: 400 });
  }
  try {
    const data = await apiFetch(`/v1/admin/changes/${n}`);
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const n = idOf(id);
  if (n === null) {
    return NextResponse.json({ detail: "invalid id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch(`/v1/admin/changes/${n}`, {
      method: "PUT",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
