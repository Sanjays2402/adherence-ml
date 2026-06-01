import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ALL_SCOPES,
  MAX_KEY_CIDRS,
  REVOKE_NOTE_MAX,
  REVOKE_REASONS,
  SELECTABLE_REVOKE_REASONS,
  listKeys,
  normalizeCidr,
  publicView,
  revokeKeyDetailed,
  updateKey,
} from "@/lib/api-keys-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { recordAudit } from "@/lib/dashboard-audit";
import { getSession } from "@/lib/session";

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

// The DELETE body is optional so old clients (curl, scripts, the existing
// SDK) keep working. When supplied it is parsed strictly so a typo in the
// reason becomes a 400 instead of a silent "unspecified".
const RevokeBodySchema = z.object({
  reason: z.enum(REVOKE_REASONS).optional(),
  note: z.string().max(REVOKE_NOTE_MAX).optional(),
});

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

  // Parse optional JSON body. An empty body is fine; a malformed body is not.
  let body: unknown = null;
  const lengthHeader = req.headers.get("content-length");
  const hasBody = (lengthHeader ? parseInt(lengthHeader, 10) > 0 : false) ||
    (req.headers.get("transfer-encoding")?.includes("chunked") ?? false);
  if (hasBody) {
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ detail: "invalid json" }, { status: 400 });
    }
  }
  const parsedBody = RevokeBodySchema.safeParse(body ?? {});
  if (!parsedBody.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsedBody.error.issues },
      { status: 400 },
    );
  }
  const reason = parsedBody.data.reason ?? null;
  const note = parsedBody.data.note ?? null;

  // Snapshot caller for audit attribution. Missing session is allowed
  // (mirrors the rest of the keys API) but is recorded as a null actor.
  const sess = await getSession(req).catch(() => null);
  const actor = sess
    ? { user_id: sess.user.id, email: sess.user.email }
    : { user_id: null, email: null };

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
    const reasonText = reason ?? "unspecified";
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "api_key",
          id,
          summary:
            `revoke API key '${target.name}' (prefix ${target.prefix}) with reason '${reasonText}'; ` +
            `future requests with this key will fail with 401`,
          before: publicView(target) as unknown as Record<string, unknown>,
        }),
      ),
    );
  }

  const result = await revokeKeyDetailed(id, { reason, note, actor });
  if (result.status === "not_found") {
    // Lost the race with a concurrent delete. Still log so the audit trail
    // shows someone tried.
    await recordAudit({
      action: "api_key.revoke",
      target: `api_key:${id}`,
      outcome: "denied",
      actor,
      metadata: { error: "not_found" },
      request: req,
    });
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }
  if (result.status === "already_revoked") {
    await recordAudit({
      action: "api_key.revoke",
      target: `api_key:${id}`,
      outcome: "denied",
      actor,
      metadata: {
        error: "already_revoked",
        prefix: target.prefix,
        previous_reason: result.before?.revoked_reason ?? "unspecified",
      },
      request: req,
    });
    return NextResponse.json(
      {
        detail: "key already revoked",
        revoked_at: result.before?.revoked_at ?? null,
        revoked_reason: result.before?.revoked_reason ?? "unspecified",
      },
      { status: 409 },
    );
  }

  await recordAudit({
    action: "api_key.revoke",
    target: `api_key:${id}`,
    outcome: "success",
    actor,
    metadata: {
      name: target.name,
      prefix: target.prefix,
      reason: result.after?.revoked_reason ?? "unspecified",
      note: result.after?.revoked_note ?? null,
      scopes: result.after?.scopes ?? [],
      // Minimal diff: a key going from active to revoked. The interesting
      // fields are the reason and timestamp, which live in the entry above.
      before: { revoked: false },
      after: { revoked: true },
    },
    request: req,
  });

  return NextResponse.json({
    ok: true,
    revoked_reason: result.after?.revoked_reason ?? "unspecified",
    revoked_at: result.after?.revoked_at ?? null,
    selectable_reasons: SELECTABLE_REVOKE_REASONS,
  });
}
