import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DecisionSchema = z.object({
  decision_reason: z.string().max(4096).nullish(),
});

const ACTIONS = new Set(["approve", "reject", "cancel"]);

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

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const data = await apiFetch(
      `/v1/admin/dual-control/${encodeURIComponent(id)}`,
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const action = req.nextUrl.searchParams.get("action") ?? "";
  if (!ACTIONS.has(action)) {
    return NextResponse.json(
      { detail: "action must be approve, reject, or cancel" },
      { status: 400 },
    );
  }
  let parsedBody: { decision_reason?: string | null } = {};
  if (action !== "cancel") {
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const parsed = DecisionSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { detail: "invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    parsedBody = parsed.data;
  }
  try {
    const data = await apiFetch(
      `/v1/admin/dual-control/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
        body: JSON.stringify(parsedBody),
        headers: { "content-type": "application/json" },
      },
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}
