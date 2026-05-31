import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  getWorkspaceForUser,
  publicSso,
  setWorkspaceSso,
} from "@/lib/workspaces-store";
import { discover } from "@/lib/oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  label: z.string().min(1).max(80),
  issuer: z.string().url(),
  client_id: z.string().min(1).max(200),
  client_secret: z.string().min(1).max(500),
  allowed_email_domains: z.array(z.string().min(3).max(253)).max(20),
  enforce: z.boolean(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json({ sso: publicSso(ws.workspace.sso), role: ws.role });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  if (ws.role !== "owner") {
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  let parsed;
  try {
    parsed = Body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  // Probe the issuer's discovery doc so we fail fast on typos instead of
  // bricking sign-in for the whole workspace once enforce is flipped.
  try {
    await discover(parsed.data.issuer);
  } catch (e) {
    return NextResponse.json(
      { detail: `oidc discovery failed: ${(e as Error).message}` },
      { status: 400 },
    );
  }
  try {
    const next = await setWorkspaceSso(id, ctx.user.id, {
      provider: "oidc",
      label: parsed.data.label,
      issuer: parsed.data.issuer,
      client_id: parsed.data.client_id,
      client_secret: parsed.data.client_secret,
      allowed_email_domains: parsed.data.allowed_email_domains,
      enforce: parsed.data.enforce,
    });
    return NextResponse.json({ sso: next });
  } catch (e) {
    return NextResponse.json({ detail: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getSession();
  if (!ctx) return NextResponse.json({ detail: "auth required" }, { status: 401 });
  const { id } = await params;
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) return NextResponse.json({ detail: "not found" }, { status: 404 });
  if (ws.role !== "owner") {
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  await setWorkspaceSso(id, ctx.user.id, null);
  return NextResponse.json({ ok: true, sso: null });
}
