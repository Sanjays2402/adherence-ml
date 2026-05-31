import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteRun, getRun, updateRun } from "@/lib/runs-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await getRun(id);
  if (!rec) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(rec);
}

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
  pinned: z.boolean().optional(),
});

export async function PATCH(
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
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const patch: {
    title?: string;
    tags?: string[];
    pinned?: boolean;
    pinned_at?: number | null;
  } = { ...parsed.data };
  if (parsed.data.pinned !== undefined) {
    patch.pinned_at = parsed.data.pinned ? Date.now() : null;
  }
  const updated = await updateRun(id, patch);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = await deleteRun(id);
  if (!ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
