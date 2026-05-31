import { NextRequest, NextResponse } from "next/server";
import { listKeys, scopesOf } from "@/lib/api-keys-store";
import { summarizeKeyUsage } from "@/lib/api-key-usage-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const keys = await listKeys();
  const key = keys.find((k) => k.id === id);
  if (!key) return NextResponse.json({ detail: "not found" }, { status: 404 });
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  const summary = await summarizeKeyUsage(id, {
    recentLimit: Number.isFinite(limit) ? limit : 50,
  });
  return NextResponse.json({
    key: {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      created_at: key.created_at,
      last_used_at: key.last_used_at,
      use_count: key.use_count,
      revoked: key.revoked,
      scopes: scopesOf(key),
    },
    ...summary,
  });
}
