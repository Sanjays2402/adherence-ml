import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const n = Number.parseInt(id, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return NextResponse.json({ detail: "invalid id" }, { status: 400 });
  }
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";
  const suffix = dryRun ? "?dry_run=true" : "";
  try {
    const data = await apiFetch(`/v1/admin/origin-allowlist/${n}${suffix}`, {
      method: "DELETE",
    });
    return NextResponse.json(data);
  } catch (err) {
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
}
