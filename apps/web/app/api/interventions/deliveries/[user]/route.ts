import { NextRequest, NextResponse } from "next/server";
import { apiFetch, ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ user: string }> },
) {
  const { user } = await ctx.params;
  const qs = req.nextUrl.searchParams.toString();
  try {
    const data = await apiFetch(
      `/v1/interventions/deliveries/${encodeURIComponent(user)}${qs ? `?${qs}` : ""}`,
    );
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        typeof err.body === "object" && err.body ? err.body : { detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json({ detail: String(err) }, { status: 502 });
  }
}
