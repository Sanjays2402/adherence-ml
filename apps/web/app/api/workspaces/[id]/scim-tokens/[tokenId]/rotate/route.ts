/**
 * Rotate a SCIM bearer token with a zero-downtime overlap window.
 *
 *   POST /api/workspaces/{id}/scim-tokens/{tokenId}/rotate
 *
 * Body (optional):
 *   { "grace_seconds": 86400 }   // 60..604800
 *
 * Returns the brand-new plaintext token (shown once) and the old token's
 * grace ``expires_at`` deadline. Owner-only. Audit-logged. Dry-run aware.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { getWorkspaceForUser } from "@/lib/workspaces-store";
import {
  rotateToken,
  DEFAULT_ROTATION_GRACE_SECONDS,
  MIN_ROTATION_GRACE_SECONDS,
  MAX_ROTATION_GRACE_SECONDS,
} from "@/lib/scim-store";
import { recordAudit } from "@/lib/dashboard-audit";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  grace_seconds: z
    .number()
    .int()
    .min(MIN_ROTATION_GRACE_SECONDS)
    .max(MAX_ROTATION_GRACE_SECONDS)
    .optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; tokenId: string }> },
) {
  const { id, tokenId } = await params;
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.json({ detail: "auth required" }, { status: 401 });
  }
  const ws = await getWorkspaceForUser(id, ctx.user.id);
  if (!ws) {
    return NextResponse.json({ detail: "not found" }, { status: 404 });
  }
  if (ws.role !== "owner") {
    await recordAudit({
      action: "scim.token.rotate",
      target: tokenId,
      outcome: "denied",
      actor: { user_id: ctx.user.id, email: ctx.user.email },
      request: req,
      metadata: { workspace_id: id, reason: "not_owner", role: ws.role },
    });
    return NextResponse.json({ detail: "owner only" }, { status: 403 });
  }
  let body: z.infer<typeof Body> = {};
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ detail: "invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { detail: "invalid body", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    body = parsed.data;
  }
  const grace = body.grace_seconds ?? DEFAULT_ROTATION_GRACE_SECONDS;

  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "scim_token",
          id: tokenId,
          summary: `would rotate SCIM token ${tokenId} with ${grace}s grace`,
        }),
      ),
    );
  }

  let result;
  try {
    result = await rotateToken(id, tokenId, {
      graceSeconds: grace,
      rotatedBy: ctx.user.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "rotate failed";
    await recordAudit({
      action: "scim.token.rotate",
      target: tokenId,
      outcome: "failure",
      actor: { user_id: ctx.user.id, email: ctx.user.email },
      request: req,
      metadata: { workspace_id: id, error: msg },
    });
    return NextResponse.json({ detail: msg }, { status: 400 });
  }
  if (!result) {
    return NextResponse.json({ detail: "token not found" }, { status: 404 });
  }
  await recordAudit({
    action: "scim.token.rotate",
    target: result.oldToken.id,
    outcome: "success",
    actor: { user_id: ctx.user.id, email: ctx.user.email },
    request: req,
    metadata: {
      workspace_id: id,
      name: result.newToken.name,
      old_token_id: result.oldToken.id,
      new_token_id: result.newToken.id,
      grace_seconds: result.graceSeconds,
      expires_at: result.oldToken.expires_at,
    },
  });
  return NextResponse.json(
    {
      plaintext: result.plaintext,
      old: result.oldToken,
      new: result.newToken,
      grace_seconds: result.graceSeconds,
    },
    { status: 201 },
  );
}
