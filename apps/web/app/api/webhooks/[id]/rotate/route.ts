/**
 * Rotate or revoke an outbound-webhook signing secret.
 *
 *   POST   /api/webhooks/:id/rotate      body: { grace_ms?: number }
 *   DELETE /api/webhooks/:id/rotate      revoke the prior (secondary) secret immediately
 *
 * Rotation generates a new signing secret, returned exactly once. The prior
 * secret continues to co-sign deliveries as `X-Adherence-Signature-Secondary`
 * for `grace_ms` (default 24h, clamped to 5m..7d) so receivers can roll the
 * verifier without dropped events. DELETE ends the grace window early.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getEndpoint,
  rotateEndpointSecret,
  revokeEndpointSecondary,
  MIN_GRACE_MS,
  MAX_GRACE_MS,
  DEFAULT_GRACE_MS,
} from "@/lib/webhooks-store";
import { isDryRun, withDryRunHeaders, dryRunBody } from "@/lib/dry-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RotateSchema = z
  .object({
    grace_ms: z
      .number()
      .int()
      .min(MIN_GRACE_MS)
      .max(MAX_GRACE_MS)
      .optional(),
  })
  .strict();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const existed = await getEndpoint(id);
  if (!existed) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let json: unknown = {};
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    try {
      json = await req.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
  }
  const parsed = RotateSchema.safeParse(json ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const grace = parsed.data.grace_ms ?? DEFAULT_GRACE_MS;

  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "webhook_signing_secret",
          id,
          summary: `rotate signing secret for '${existed.name || existed.url}'; prior secret co-signs for ${Math.round(grace / 60000)}m`,
          before: {
            secret_prefix: existed.secret_prefix,
            secondary_secret_prefix: existed.secondary_secret_prefix ?? null,
            secondary_expires_at: existed.secondary_expires_at ?? null,
          },
        }),
      ),
    );
  }

  const result = await rotateEndpointSecret(id, grace);
  if (!result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      id: result.record.id,
      // surfaced exactly once
      secret: result.secret,
      secret_prefix: result.record.secret_prefix,
      secret_rotated_at: result.record.secret_rotated_at ?? null,
      secondary_secret_prefix: result.record.secondary_secret_prefix ?? null,
      secondary_expires_at: result.secondary_expires_at,
      grace_ms: grace,
    },
    { status: 200 },
  );
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const existed = await getEndpoint(id);
  if (!existed) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (isDryRun(req)) {
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "webhook_signing_secret_secondary",
          id,
          summary: `revoke prior signing secret for '${existed.name || existed.url}' immediately`,
          before: {
            secondary_secret_prefix: existed.secondary_secret_prefix ?? null,
            secondary_expires_at: existed.secondary_expires_at ?? null,
          },
        }),
      ),
    );
  }
  const cleared = await revokeEndpointSecondary(id);
  return NextResponse.json({ ok: true, cleared });
}
