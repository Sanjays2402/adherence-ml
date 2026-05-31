import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ALL_SCOPES,
  MAX_KEY_CIDRS,
  listKeys,
  normalizeCidr,
  publicView,
  revokeKey,
  updateKey,
} from "@/lib/api-keys-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  scopes: z.array(z.enum(ALL_SCOPES)).optional(),
  // null clears the per-key cap, positive int sets it. Capped server-side.
  daily_quota: z.number().int().min(1).max(10_000_000).nullable().optional(),
  // null clears the IP pin; an array replaces it. Each entry must be a valid
  // IPv4 or IPv6 CIDR (a bare IP is treated as a /32 or /128 host route).
  allowed_cidrs: z.array(z.string().min(1).max(64)).max(MAX_KEY_CIDRS).nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  // 400 on malformed CIDR so users see the error instead of silent drop.
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
  const updated = await updateKey(id, parsed.data);
  if (!updated) {
    return NextResponse.json(
      { detail: "not found or revoked" },
      { status: 404 },
    );
  }
  return NextResponse.json(publicView(updated));
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  // Peek without mutating so we can render dry-run previews AND return a
  // helpful 404 in the live path before touching the write queue.
  const keys = await listKeys();
  const target = keys.find((k) => k.id === id);
  if (!target) return NextResponse.json({ detail: "not found" }, { status: 404 });

  if (isDryRun(req)) {
    if (target.revoked) {
      return withDryRunHeaders(
        NextResponse.json(
          dryRunBody({
            resource: "api_key",
            id,
            summary: "already revoked, no change would be made",
            before: publicView(target) as unknown as Record<string, unknown>,
          }),
        ),
      );
    }
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "api_key",
          id,
          summary: `revoke API key '${target.name}' (prefix ${target.prefix}); future requests with this key will fail with 401`,
          before: publicView(target) as unknown as Record<string, unknown>,
        }),
      ),
    );
  }

  const ok = await revokeKey(id);
  if (!ok) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
