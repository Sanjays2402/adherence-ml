import { NextRequest, NextResponse } from "next/server";
import { deleteNote } from "@/lib/notes-store";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  const { noteId } = await params;
  const sess = await getSession(req);
  const ok = await deleteNote(noteId, sess?.user.id ?? null);
  if (!ok) {
    return NextResponse.json(
      { error: "not_found_or_forbidden", detail: "note missing or not yours" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
