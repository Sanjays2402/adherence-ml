import { NextResponse } from "next/server";

import { getShare, deleteShare } from "@/lib/shares";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const record = await getShare(id);
  if (!record) {
    return NextResponse.json(
      { error: "not_found", detail: `no share with id ${id}` },
      { status: 404 },
    );
  }
  return NextResponse.json(record);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await getSession();
  // Owner check: if a session exists, only that user can delete their share.
  // No session (dev / single-tenant) falls through to unscoped delete.
  const result = await deleteShare(id, session ? { user_id: session.payload.uid } : {});
  if (result.deleted) {
    return NextResponse.json({ deleted: true, id });
  }
  if (result.reason === "forbidden") {
    return NextResponse.json(
      { error: "forbidden", detail: "share is owned by a different account" },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { error: "not_found", detail: `no share with id ${id}` },
    { status: 404 },
  );
}
