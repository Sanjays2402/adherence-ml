import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getRun } from "@/lib/runs-store";
import {
  createNote,
  listNotesForRun,
} from "@/lib/notes-store";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  body: z.string().min(1).max(2000),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) {
    return NextResponse.json(
      { error: "not_found", detail: `no run with id ${id}` },
      { status: 404 },
    );
  }
  const notes = await listNotesForRun(id);
  return NextResponse.json({ items: notes, total: notes.length });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) {
    return NextResponse.json(
      { error: "not_found", detail: `no run with id ${id}` },
      { status: 404 },
    );
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const sess = await getSession(req);
  const rec = await createNote({
    run_id: id,
    body: parsed.data.body,
    user_id: sess?.user.id ?? null,
    author_email: sess?.user.email ?? null,
  });
  return NextResponse.json(rec, { status: 201 });
}
