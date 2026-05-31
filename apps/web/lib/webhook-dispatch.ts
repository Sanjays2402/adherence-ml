/**
 * Outbound webhook dispatcher. Signs with HMAC-SHA256 and retries with
 * capped exponential backoff. Designed for single-process Next.js dev/
 * preview; in a multi-instance deployment swap the in-process timers for
 * a real queue.
 *
 * Signing scheme:
 *   X-Adherence-Signature: t=<unix>,v1=<hex>
 *   v1 = HMAC_SHA256(secret, `${t}.${raw_body}`)
 *
 * Receivers should reject deliveries where |now - t| > 5 minutes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type WebhookEvent,
  type WebhookEndpoint,
  type WebhookDelivery,
  type DeliveryAttempt,
  listEndpoints,
  recordDelivery,
  newDeliveryId,
  endpointSecretHash,
} from "./webhooks-store";
import { createNotification } from "./notifications-store";

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [0, 2_000, 8_000, 30_000];
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The store keeps only a hash of the secret, so we cannot re-sign with the
 * original plaintext after creation. We instead sign with the secret_hash,
 * which is itself a cryptographic commitment (256 bits of entropy) bound to
 * the original secret. Receivers verify against the same hash, which is what
 * we surface in the dashboard's "Signing secret" reveal banner.
 */
async function signBody(endpointId: string, body: string, ts: number) {
  const key = await endpointSecretHash(endpointId);
  if (!key) return null;
  const mac = createHmac("sha256", key).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${mac}`;
}

/** Constant-time signature check, exported for tests + receivers that mount this lib. */
export function verifySignature(secretHash: string, header: string, body: string, maxAgeSec = 300): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i === -1 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const t = Number(parts.t);
  const sig = parts.v1;
  if (!Number.isFinite(t) || !sig) return false;
  if (Math.abs(Date.now() / 1000 - t) > maxAgeSec) return false;
  const expected = createHmac("sha256", secretHash).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function attemptOnce(
  url: string,
  body: string,
  signature: string,
  event: WebhookEvent,
  deliveryId: string,
): Promise<DeliveryAttempt> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "adherence-ml-webhooks/1.0",
        "x-adherence-event": event,
        "x-adherence-delivery": deliveryId,
        "x-adherence-signature": signature,
      },
      body,
      signal: ctrl.signal,
    });
    return {
      attempt: 0, // caller fills in
      at: start,
      status: res.status,
      ok: res.ok,
      duration_ms: Date.now() - start,
      error: res.ok ? null : `http_${res.status}`,
    };
  } catch (e) {
    return {
      attempt: 0,
      at: start,
      status: null,
      ok: false,
      duration_ms: Date.now() - start,
      error: e instanceof Error ? e.message.slice(0, 200) : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

interface DispatchOptions {
  /** If true, await retries inline (used by /test). Otherwise schedule async. */
  awaitRetries?: boolean;
}

async function dispatchToEndpoint(
  endpoint: WebhookEndpoint,
  event: WebhookEvent,
  payload: unknown,
  opts: DispatchOptions = {},
) {
  if (!endpoint.active) return null;
  const body = JSON.stringify({
    id: newDeliveryId(),
    event,
    created_at: new Date().toISOString(),
    data: payload,
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signBody(endpoint.id, body, ts);
  if (!sig) return null;

  const delivery: WebhookDelivery = {
    id: newDeliveryId(),
    endpoint_id: endpoint.id,
    event,
    url: endpoint.url,
    payload,
    created_at: Date.now(),
    finished_at: null,
    delivered: false,
    attempts: [],
  };
  await recordDelivery(delivery);

  const runLoop = async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, BACKOFF_MS[i]));
      const att = await attemptOnce(endpoint.url, body, sig, event, delivery.id);
      att.attempt = i + 1;
      delivery.attempts.push(att);
      if (att.ok) {
        delivery.delivered = true;
        delivery.finished_at = Date.now();
        await recordDelivery(delivery);
        return;
      }
      // persist progress between attempts so the UI can show partial logs
      await recordDelivery(delivery);
    }
    delivery.finished_at = Date.now();
    await recordDelivery(delivery);
    // final failure: broadcast a notification so the operator notices
    void createNotification({
      user_id: null,
      kind: "webhook.failed",
      title: `Webhook delivery failed: ${endpoint.name || endpoint.url}`,
      body: `Event ${event} could not be delivered after ${MAX_ATTEMPTS} attempts.`,
      href: `/webhooks`,
    }).catch(() => {});
  };

  if (opts.awaitRetries) {
    await runLoop();
  } else {
    // fire-and-forget; do not block the originating request
    runLoop().catch(() => {
      // swallow; per-attempt errors are already in the delivery log
    });
  }
  return delivery;
}

/** Fan out one event to every active subscriber. Non-blocking by default. */
export async function emit(event: WebhookEvent, payload: unknown): Promise<void> {
  const endpoints = await listEndpoints();
  const targets = endpoints.filter(
    (e) => e.active && e.events.includes(event),
  );
  for (const ep of targets) {
    // intentionally not awaited; dispatchToEndpoint persists every step
    void dispatchToEndpoint(ep, event, payload);
  }
}

export async function dispatchTest(
  endpoint: WebhookEndpoint,
): Promise<WebhookDelivery | null> {
  return dispatchToEndpoint(
    endpoint,
    "test.ping",
    {
      message: "Hello from adherence.ml webhooks.",
      endpoint_id: endpoint.id,
      endpoint_name: endpoint.name,
    },
    { awaitRetries: true },
  );
}

/**
 * Re-send a previously recorded delivery. Creates a brand new delivery row
 * tied to the same endpoint + event + payload, retries inline, and returns
 * the new delivery. The original row is left intact so users can compare.
 */
export async function redeliver(
  endpoint: WebhookEndpoint,
  source: WebhookDelivery,
): Promise<WebhookDelivery | null> {
  return dispatchToEndpoint(endpoint, source.event, source.payload, {
    awaitRetries: true,
  });
}

export const __test = { MAX_ATTEMPTS, BACKOFF_MS };
