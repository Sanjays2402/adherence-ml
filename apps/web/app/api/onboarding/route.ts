import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  readOnboarding,
  markStep,
  setDismissed,
  STEP_IDS,
} from "@/lib/onboarding-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const s = await readOnboarding();
  return NextResponse.json(s);
}

const PatchSchema = z
  .object({
    step: z.enum(STEP_IDS as [string, ...string[]]).optional(),
    done: z.boolean().optional(),
    dismissed: z.boolean().optional(),
  })
  .strict();

export async function PATCH(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { step, done, dismissed } = parsed.data;
  let next = await readOnboarding();
  if (step !== undefined) {
    next = await markStep(step as (typeof STEP_IDS)[number], done ?? true);
  }
  if (dismissed !== undefined) {
    next = await setDismissed(dismissed);
  }
  return NextResponse.json(next);
}
