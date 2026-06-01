import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHANGE_TYPES = ["standard", "normal", "emergency"] as const;
const RISK_CLASSES = ["low", "medium", "high", "critical"] as const;

const CreateSchema = z.object({
  title: z.string().min(4).max(200),
  change_type: z.enum(CHANGE_TYPES),
  risk_class: z.enum(RISK_CLASSES),
  affected_service: z.string().min(2).max(128),
  rollback_plan: z.string().min(4).max(4096),
  requester_email: z.string().email().max(254),
  approver_email: z.string().email().max(254).nullish(),
  notes: z.string().max(4096).nullish(),
  reference: z.string().max(128).nullish(),
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

export async function GET(req: NextRequest) {
  const include = req.nextUrl.searchParams.get("include_archived") ?? "false";
  const status = req.nextUrl.searchParams.get("status");
  const qs = new URLSearchParams({ include_archived: include });
  if (status) qs.set("status", status);
  try {
    const data = await apiFetch(`/v1/admin/changes?${qs.toString()}`);
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
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch("/v1/admin/changes", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
