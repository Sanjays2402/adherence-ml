import { NextResponse } from "next/server";
import { z } from "zod";
import { PLANS, changePlan, readPlan } from "@/lib/plan-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const state = await readPlan();
  const plan = PLANS[state.current];
  return NextResponse.json({
    current: plan,
    state,
    plans: Object.values(PLANS),
  });
}

const PostBody = z.object({
  plan: z.enum(["free", "pro", "scale"]),
  reason: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { detail: "invalid json body" },
      { status: 400 },
    );
  }
  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid plan", errors: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const { plan, reason } = parsed.data;
  const result = await changePlan(plan, reason ?? "self-service");
  return NextResponse.json({
    current: result.plan,
    state: result.state,
    changed: result.changed,
  });
}
