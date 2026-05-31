/**
 * Key-authenticated webhook delivery redelivery.
 *
 *   curl -X POST 'http://localhost:3000/v1/webhooks/deliveries/<id>/redeliver' \
 *     -H "authorization: Bearer adh_..."
 *
 * Requires the `webhooks` scope. Emits the standard `X-RateLimit-*` headers,
 * supports `?dry_run=true` for change-control review, and is the programmatic
 * equivalent of the dashboard replay button so enterprise ops teams can
 * script replays from their own runbooks.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  clientIpFromHeaders,
  extractKey,
  hasScope,
  ipAllowedForKey,
  scopesOf,
  verifyKey,
} from "@/lib/api-keys-store";
import { recordKeyUsage } from "@/lib/api-key-usage-store";
import { getDelivery, getEndpoint } from "@/lib/webhooks-store";
import { redeliver } from "@/lib/webhook-dispatch";
import { isDryRun, withDryRunHeaders } from "@/lib/dry-run";
import { over429, rateLimitHeaders, readBudget } from "@/lib/v1-ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/v1/webhooks/deliveries/[id]/redeliver";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const started = Date.now();
  const presented = extractKey(req.headers);
  if (!presented) {
    return NextResponse.json(
      {
        detail:
          "missing api key. send Authorization: Bearer <key> or x-api-key: <key>",
      },
      { status: 401 },
    );
  }
  const key = await verifyKey(presented);
  if (!key) {
    return NextResponse.json(
      { detail: "invalid or revoked api key" },
      { status: 401 },
    );
  }
  if (!ipAllowedForKey(key, clientIpFromHeaders(req.headers))) {
    return NextResponse.json(
      { detail: "source ip not allowed for this api key" },
      { status: 403 },
    );
  }
  if (!hasScope(key, "webhooks")) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "POST",
      path: ROUTE,
      status: 403,
      latency_ms: Date.now() - started,
    }).catch(() => {});
    return NextResponse.json(
      {
        detail: "this api key is missing the 'webhooks' scope.",
        key_scopes: scopesOf(key),
        required_scope: "webhooks",
      },
      { status: 403 },
    );
  }

  const dry = isDryRun(req);
  const budget = await readBudget(key);
  if (!dry) {
    const over = over429(budget, 1);
    if (over) {
      void recordKeyUsage({
        key_id: key.id,
        ts: Date.now(),
        method: "POST",
        path: ROUTE,
        status: 429,
        latency_ms: Date.now() - started,
      }).catch(() => {});
      return over;
    }
  }

  const { id } = await ctx.params;
  if (!id || typeof id !== "string" || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ detail: "invalid delivery id" }, { status: 400 });
  }

  const source = await getDelivery(id);
  if (!source) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "POST",
      path: ROUTE,
      status: 404,
      latency_ms: Date.now() - started,
    }).catch(() => {});
    return NextResponse.json(
      { detail: "delivery not found" },
      { status: 404, headers: rateLimitHeaders(budget, 0) },
    );
  }
  const ep = await getEndpoint(source.endpoint_id);
  if (!ep) {
    return NextResponse.json(
      { detail: "the original endpoint has been deleted" },
      { status: 410, headers: rateLimitHeaders(budget, 0) },
    );
  }
  if (!ep.active) {
    return NextResponse.json(
      { detail: "enable the endpoint before redelivering" },
      { status: 409, headers: rateLimitHeaders(budget, 0) },
    );
  }

  if (dry) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "POST",
      path: ROUTE,
      status: 200,
      latency_ms: Date.now() - started,
    }).catch(() => {});
    return withDryRunHeaders(
      NextResponse.json(
        {
          dry_run: true,
          would: "redeliver",
          preview: {
            resource: "webhook_delivery",
            id: source.id,
            summary: `would redeliver event ${source.event} to ${ep.url}`,
            cascade: [],
            before: {
              endpoint_id: ep.id,
              event: source.event,
              url: ep.url,
            },
          },
        },
        { headers: rateLimitHeaders(budget, 0) },
      ),
    );
  }

  const fresh = await redeliver(ep, source);
  if (!fresh) {
    void recordKeyUsage({
      key_id: key.id,
      ts: Date.now(),
      method: "POST",
      path: ROUTE,
      status: 500,
      latency_ms: Date.now() - started,
    }).catch(() => {});
    return NextResponse.json(
      { detail: "dispatch_failed" },
      { status: 500, headers: rateLimitHeaders(budget, 1) },
    );
  }

  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method: "POST",
    path: ROUTE,
    status: 200,
    latency_ms: Date.now() - started,
  }).catch(() => {});

  return NextResponse.json(
    {
      delivery_id: fresh.id,
      source_id: source.id,
      endpoint_id: ep.id,
      event: source.event,
      delivered: fresh.delivered,
      attempts: fresh.attempts.length,
    },
    { headers: rateLimitHeaders(budget, 1) },
  );
}
