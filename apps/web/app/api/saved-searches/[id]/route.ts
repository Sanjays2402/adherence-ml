/**
 * Saved search item endpoint.
 *
 *   PATCH  /api/saved-searches/<id>   -> rename ({ name })
 *   DELETE /api/saved-searches/<id>   -> tombstone
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  deleteSavedSearch,
  renameSavedSearch,
} from "@/lib/saved-searches-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANON = "_anon";

const PatchSchema = z.object({
  name: z.string().min(1).max(80),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const session = await getSession(req);
  const uid = session?.user.id ?? ANON;
  const rec = await renameSavedSearch(uid, id, parsed.data.name);
  if (!rec) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(rec);
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = await getSession(req);
  const uid = session?.user.id ?? ANON;
  const ok = await deleteSavedSearch(uid, id);
  if (!ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
