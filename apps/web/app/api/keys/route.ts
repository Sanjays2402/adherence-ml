import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ALL_SCOPES,
  MAX_KEY_CIDRS,
  createKey,
  listKeys,
  normalizeAllowedCidrs,
  normalizeCidr,
  normalizeScopes,
  publicView,
  ttlToExpiresAt,
} from "@/lib/api-keys-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const keys = await listKeys();
  // never leak the hash to the client
  return NextResponse.json({
    keys: keys.map(publicView),
    available_scopes: ALL_SCOPES,
    ttl_presets_days: [7, 30, 90, 365],
  });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(ALL_SCOPES)).optional(),
  // Optional TTL in days. null/0/omitted means the key never expires.
  // Capped server-side at 10 years inside ttlToExpiresAt.
  ttl_days: z.number().int().min(0).max(3650).nullable().optional(),
  // Optional per-key client IP allowlist as a list of CIDRs (IPv4/IPv6).
  // null or omitted leaves the key open to any source IP. An empty array is
  // also treated as "any". Capped at MAX_KEY_CIDRS entries.
  allowed_cidrs: z.array(z.string().min(1).max(64)).max(MAX_KEY_CIDRS).nullable().optional(),
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
  const expiresAt = ttlToExpiresAt(parsed.data.ttl_days ?? null);
  // Reject obviously malformed CIDR strings so callers get a 400 instead of
  // silently having entries dropped by normalizeAllowedCidrs.
  if (Array.isArray(parsed.data.allowed_cidrs)) {
    for (const c of parsed.data.allowed_cidrs) {
      if (!normalizeCidr(c)) {
        return NextResponse.json(
          { detail: `invalid cidr: ${c}` },
          { status: 400 },
        );
      }
    }
  }
  const allowedCidrs =
    parsed.data.allowed_cidrs === undefined
      ? null
      : normalizeAllowedCidrs(parsed.data.allowed_cidrs);
  const { record, plaintext } = await createKey(
    parsed.data.name,
    scopes,
    expiresAt,
    allowedCidrs,
  );
  return NextResponse.json({
    ...publicView(record),
    key: plaintext, // shown exactly once
  });
}
