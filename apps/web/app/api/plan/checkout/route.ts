/**
 * Simulated checkout. Returns a short-lived session id and the URL the
 * client should redirect to (in this build, /billing?session=...). Swap
 * the body of this handler for a real Stripe Checkout Session and the
 * client code does not change. See README -> "Billing & plans".
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PLANS, changePlan } from "@/lib/plan-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  plan: z.enum(["free", "pro", "scale"]),
});

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json body" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid plan", errors: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const { plan } = parsed.data;
  const session_id = `chk_${randomBytes(8).toString("hex")}`;

  // Single-tenant self-serve build: apply the plan change immediately so
  // /usage and /v1/predict reflect the new quota with no Stripe webhook
  // round trip. Real Stripe wiring moves this into the webhook handler.
  const result = await changePlan(plan, `checkout:${session_id}`);

  return NextResponse.json({
    session_id,
    redirect_url: `/billing?session=${session_id}`,
    plan: PLANS[plan],
    changed: result.changed,
  });
}
