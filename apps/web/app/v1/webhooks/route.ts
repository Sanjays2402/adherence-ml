/**
 * Key-authenticated webhook endpoint management.
 *
 * List your registered webhook endpoints:
 *   curl http://localhost:3000/v1/webhooks \
 *     -H "authorization: Bearer adh_..."
 *
 * Register a new endpoint (returns plaintext secret exactly once):
 *   curl -X POST http://localhost:3000/v1/webhooks \
 *     -H "authorization: Bearer adh_..." \
 *     -H "content-type: application/json" \
 *     -d '{"name":"prod","url":"https://example.com/hook","events":["run.created"]}'
 *
 * Requires the `webhooks` scope. The `read` scope is also accepted for GET so
 * existing read-scoped keys can audit without re-issuance.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  clientIpFromHeaders,
  extractKey,
  hasScope,
  ipAllowedForKey,
  scopesOf,
  type ApiKeyRecord,
  type KeyScope,
  verifyKey,
} from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import {
  createEndpoint,
  isValidUrl,
  listEndpoints,
  type WebhookEvent,
} from "@/lib/webhooks-store";
import { STABLE_EVENT_TYPES } from "@/lib/webhook-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_EVENTS = STABLE_EVENT_TYPES as unknown as [string, ...string[]];

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  url: z
    .string()
    .min(1)
    .max(500)
    .refine(isValidUrl, { message: "must be http(s) URL" }),
  events: z.array(z.enum(ALLOWED_EVENTS)).optional(),
});

function publicEndpoint(e: Awaited<ReturnType<typeof listEndpoints>>[number]) {
  return {
    id: e.id,
    name: e.name,
    url: e.url,
    events: e.events,
    secret_prefix: e.secret_prefix,
    active: e.active,
    created_at: e.created_at,
    last_delivery_at: e.last_delivery_at,
    success_count: e.success_count,
    failure_count: e.failure_count,
  };
}

async function authenticate(
  req: NextRequest,
): Promise<
  | { ok: true; key: ApiKeyRecord; scopes: KeyScope[] }
  | { ok: false; response: NextResponse }
> {
  const presented = extractKey(req.headers);
  if (!presented) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          detail:
            "missing api key. send Authorization: Bearer <key> or x-api-key: <key>",
        },
        { status: 401 },
      ),
    };
  }
  const key = await verifyKey(presented, { client_ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null, user_agent: req.headers.get("user-agent") });
  if (!key) {
    return {
      ok: false,
      response: NextResponse.json(
        { detail: "invalid or revoked api key" },
        { status: 401 },
      ),
    };
  }
  if (!ipAllowedForKey(key, clientIpFromHeaders(req.headers))) {
    return {
      ok: false,
      response: NextResponse.json(
        { detail: "source ip not allowed for this api key" },
        { status: 403 },
      ),
    };
  }
  if (!ipAllowedForKey(key, clientIpFromHeaders(req.headers))) {
    return {
      ok: false,
      response: NextResponse.json(
        { detail: "source ip not allowed for this api key" },
        { status: 403 },
      ),
    };
  }
  return { ok: true, key, scopes: scopesOf(key) };
}

function logUsage(
  key: ApiKeyRecord,
  method: string,
  status: number,
  startedAt: number,
) {
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method,
    path: "/v1/webhooks",
    status,
    latency_ms: Date.now() - startedAt,
  }).catch(() => {});
}

export async function GET(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  if (!hasScope(auth.key, "webhooks") && !hasScope(auth.key, "read")) {
    logUsage(auth.key, "GET", 403, started);
    return NextResponse.json(
      {
        detail: "this api key is missing the 'webhooks' or 'read' scope.",
        key_scopes: auth.scopes,
        required_scope: "webhooks",
      },
      { status: 403 },
    );
  }
  const endpoints = await listEndpoints();
  logUsage(auth.key, "GET", 200, started);
  return NextResponse.json({ endpoints: endpoints.map(publicEndpoint) });
}

export async function POST(req: NextRequest) {
  const started = Date.now();
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  if (!hasScope(auth.key, "webhooks")) {
    logUsage(auth.key, "POST", 403, started);
    return NextResponse.json(
      {
        detail: "this api key is missing the 'webhooks' scope.",
        key_scopes: auth.scopes,
        required_scope: "webhooks",
      },
      { status: 403 },
    );
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    logUsage(auth.key, "POST", 400, started);
    return NextResponse.json(
      { detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = CreateSchema.safeParse(json);
  if (!parsed.success) {
    logUsage(auth.key, "POST", 422, started);
    return NextResponse.json(
      { detail: "validation_failed", errors: parsed.error.flatten() },
      { status: 422 },
    );
  }
  try {
    const created = await createEndpoint({
      name: parsed.data.name,
      url: parsed.data.url,
      events: parsed.data.events as WebhookEvent[] | undefined,
    });
    logUsage(auth.key, "POST", 201, started);
    return NextResponse.json(
      {
        ...publicEndpoint(created.record),
        // returned exactly once; persist immediately on the client side
        secret: created.secret,
      },
      { status: 201 },
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : "create_failed";
    if (detail.startsWith("ssrf_blocked:")) {
      logUsage(auth.key, "POST", 422, started);
      return NextResponse.json(
        {
          detail: "Destination blocked by workspace webhook security policy.",
          error: "ssrf_blocked",
          reason: detail.slice("ssrf_blocked:".length),
        },
        { status: 422 },
      );
    }
    logUsage(auth.key, "POST", 400, started);
    return NextResponse.json({ detail }, { status: 400 });
  }
}
