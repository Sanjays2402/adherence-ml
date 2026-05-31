import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteRun, getRun, updateRun } from "@/lib/runs-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

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
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rec = await getRun(id);
  if (!rec) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "run",
          id,
          summary: `delete run '${rec.title ?? id}' (${rec.kind}); history, notes, and shares scoped to this run will lose their parent`,
          before: {
            id: rec.id,
            kind: rec.kind,
            title: rec.title,
            tags: rec.tags,
            pinned: rec.pinned,
            created_at: rec.created_at,
          },
        }),
      ),
    );
  }
  const ok = await deleteRun(id);
  if (!ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
