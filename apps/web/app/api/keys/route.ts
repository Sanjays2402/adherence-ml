import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ALL_SCOPES, createKey, listKeys, normalizeScopes, scopesOf } from "@/lib/api-keys-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const keys = await listKeys();
  // never leak the hash to the client
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      created_at: k.created_at,
      last_used_at: k.last_used_at,
      use_count: k.use_count,
      revoked: k.revoked,
      rotated_at: k.rotated_at ?? null,
      scopes: scopesOf(k),
    })),
    available_scopes: ALL_SCOPES,
  });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(ALL_SCOPES)).optional(),
});

export async function POST(req: NextRequest) {
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
  const scopes = normalizeScopes(parsed.data.scopes);
  const { record, plaintext } = await createKey(parsed.data.name, scopes);
  return NextResponse.json({
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    created_at: record.created_at,
    scopes: scopesOf(record),
    key: plaintext, // shown exactly once
  });
}
