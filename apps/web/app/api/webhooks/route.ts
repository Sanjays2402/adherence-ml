import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createEndpoint,
  listEndpoints,
  isValidUrl,
} from "@/lib/webhooks-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PostSchema = z.object({
  name: z.string().min(1).max(80),
  url: z
    .string()
    .min(1)
    .max(500)
    .refine(isValidUrl, { message: "must be http(s) URL" }),
  events: z.array(z.enum(["run.created", "test.ping"])).optional(),
});

export async function GET() {
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
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  try {
    const created = await createEndpoint(parsed.data);
    return NextResponse.json(
      {
        id: created.record.id,
        name: created.record.name,
        url: created.record.url,
        events: created.record.events,
        secret_prefix: created.record.secret_prefix,
        // surfaced exactly once; the dashboard tells users to copy it now
        secret: created.secret,
        active: created.record.active,
        created_at: created.record.created_at,
      },
      { status: 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create_failed";
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
