import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteEndpoint,
  setEndpointActive,
  getEndpoint,
} from "@/lib/webhooks-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({ active: z.boolean() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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
  const updated = await setEndpointActive(id, parsed.data.active);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({
    id: updated.id,
    active: updated.active,
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const existed = await getEndpoint(id);
  if (!existed) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await deleteEndpoint(id);
  return NextResponse.json({ ok: true });
}
