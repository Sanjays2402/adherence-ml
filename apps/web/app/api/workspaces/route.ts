import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { createWorkspace, listForUser } from "@/lib/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const items = await listForUser(ctx.user.id, ctx.user.email);
  return NextResponse.json({ items });
}

const CreateSchema = z.object({ name: z.string().min(1).max(80) });

export async function POST(req: NextRequest) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const ws = await createWorkspace(ctx.user.id, ctx.user.email, parsed.data.name);
  return NextResponse.json({ workspace: ws });
}
