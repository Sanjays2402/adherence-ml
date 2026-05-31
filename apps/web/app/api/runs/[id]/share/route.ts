import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRun, setRunShared } from "@/lib/runs-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PostSchema = z.object({
  enabled: z.boolean(),
});

function publicUrl(req: NextRequest, token: string): string {
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/share/${token}`;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await getRun(id);
  if (!rec) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    id: rec.id,
    enabled: Boolean(rec.share_token),
    token: rec.share_token ?? null,
    shared_at: rec.shared_at ?? null,
    url: rec.share_token ? publicUrl(req, rec.share_token) : null,
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const updated = await setRunShared(id, parsed.data.enabled);
  if (!updated) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    id: updated.id,
    enabled: Boolean(updated.share_token),
    token: updated.share_token ?? null,
    shared_at: updated.shared_at ?? null,
    url: updated.share_token ? publicUrl(req, updated.share_token) : null,
  });
}
