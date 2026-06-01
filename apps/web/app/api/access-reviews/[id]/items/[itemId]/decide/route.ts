import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DecideSchema = z.object({
  decision: z.enum(["keep", "change", "revoke"]),
  new_role: z.string().min(1).max(64).nullish(),
  note: z.string().max(4096).nullish(),
});

function bubble(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json(
      typeof err.body === "object" && err.body !== null ? err.body : { detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { detail: err instanceof Error ? err.message : "upstream error" },
    { status: 502 },
  );
}

function fwd(req: NextRequest): HeadersInit {
  const h: Record<string, string> = { "content-type": "application/json" };
  const mfa = req.headers.get("x-mfa-code");
  if (mfa) h["X-MFA-Code"] = mfa;
  return h;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await ctx.params;
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ detail: "invalid json" }, { status: 400 }); }
  const parsed = DecideSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (parsed.data.decision === "change" && !parsed.data.new_role) {
    return NextResponse.json(
      { detail: "new_role required when decision is change" },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch(
      `/v1/admin/access-reviews/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/decide`,
      { method: "POST", body: JSON.stringify(parsed.data), headers: fwd(req) },
    );
    return NextResponse.json(data);
  } catch (err) { return bubble(err); }
}
