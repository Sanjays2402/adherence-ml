import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createEndpoint,
  listEndpoints,
  isValidUrl,
  type WebhookEvent,
} from "@/lib/webhooks-store";
import { STABLE_EVENT_TYPES } from "@/lib/webhook-catalog";
import { auditAction, requireDashboardAuth } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PostSchema = z.object({
  name: z.string().min(1).max(80),
  url: z
    .string()
    .min(1)
    .max(500)
    .refine(isValidUrl, { message: "must be http(s) URL" }),
  events: z
    .array(z.enum(STABLE_EVENT_TYPES as unknown as [string, ...string[]]))
    .optional(),
});

export async function GET(req: NextRequest) {
  // Webhook URLs and secret prefixes are sensitive: they reveal what
  // partner systems this workspace integrates with and provide
  // targeting data for SSRF probes. Gate on session.
  const auth = await requireDashboardAuth(req, {
    action: "webhook.endpoints.list",
  });
  if (!auth.ok) return auth.response;
  const endpoints = await listEndpoints();
  const now = Date.now();
  // never leak the hash
  return NextResponse.json({
    endpoints: endpoints.map((e) => {
      const secondaryActive =
        !!e.secondary_secret_hash &&
        !!e.secondary_expires_at &&
        e.secondary_expires_at > now;
      return {
        id: e.id,
        name: e.name,
        url: e.url,
        events: e.events,
        secret_prefix: e.secret_prefix,
        secret_rotated_at: e.secret_rotated_at ?? null,
        secondary_secret_prefix: secondaryActive
          ? e.secondary_secret_prefix ?? null
          : null,
        secondary_expires_at: secondaryActive
          ? e.secondary_expires_at ?? null
          : null,
        active: e.active,
        created_at: e.created_at,
        last_delivery_at: e.last_delivery_at,
        success_count: e.success_count,
        failure_count: e.failure_count,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireDashboardAuth(req, {
    action: "webhook.endpoint.create",
  });
  if (!auth.ok) return auth.response;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) {
    await auditAction(req, auth.ctx, {
      action: "webhook.endpoint.create",
      outcome: "denied",
      metadata: { reason: "validation_failed" },
    });
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  try {
    const created = await createEndpoint({
      name: parsed.data.name,
      url: parsed.data.url,
      events: parsed.data.events as WebhookEvent[] | undefined,
    });
    await auditAction(req, auth.ctx, {
      action: "webhook.endpoint.create",
      target: `webhook_endpoint:${created.record.id}`,
      metadata: {
        name: created.record.name,
        url: created.record.url,
        events: created.record.events,
      },
    });
    return NextResponse.json(
      {
        id: created.record.id,
        name: created.record.name,
        url: created.record.url,
        events: created.record.events,
        secret_prefix: created.record.secret_prefix,
        active: created.record.active,
        created_at: created.record.created_at,
        // returned exactly once
        secret: created.secret,
      },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create_failed";
    await auditAction(req, auth.ctx, {
      action: "webhook.endpoint.create",
      outcome: "denied",
      metadata: { reason: msg },
    });
    if (msg.startsWith("ssrf_blocked:")) {
      return NextResponse.json(
        {
          error: "ssrf_blocked",
          reason: msg.slice("ssrf_blocked:".length),
          detail:
            "Destination is blocked by workspace webhook security policy. Update the policy at /workspace/security or pick a public URL.",
        },
        { status: 422 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
