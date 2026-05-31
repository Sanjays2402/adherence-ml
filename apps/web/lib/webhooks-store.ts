/**
 * Outbound webhooks store. File-backed, dependency-free, mirrors the
 * api-keys-store / runs-store pattern.
 *
 * - An "endpoint" is a user-registered URL we POST events to.
 * - A "delivery" is one attempt (with retries) to send one event to one endpoint.
 *
 * Signing: every outbound POST includes `X-Adherence-Signature: sha256=<hex>`
 * computed as HMAC_SHA256(secret, raw_body). Secret is returned exactly once
 * at endpoint creation; only a hash is persisted.
 *
 * Secret rotation: customers can rotate the signing secret with a grace
 * window (default 24h, max 7d). During the window we sign with BOTH the
 * new primary secret and the old secret (sent as
 * `X-Adherence-Signature-Secondary`), letting receivers deploy the new
 * secret with zero dropped deliveries. The old secret auto-expires; a
 * `secondary_expires_at` cursor is enforced lazily on read and on
 * dispatch. Owners can also kill the old secret instantly via
 * `revokeSecondary`.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { preflightUrl } from "./webhook-ssrf";
import { effectiveWebhookSsrfPolicy } from "./workspaces-store";

export type WebhookEvent = "run.created" | "test.ping";

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  secret_prefix: string; // first 10 chars of plaintext secret for UI
  secret_hash: string; // sha256(plaintext)
  /** Unix ms when the current (primary) secret was last (re)issued. */
  secret_rotated_at?: number | null;
  /** First chars of the prior secret (UI only) while the grace window is open. */
  secondary_secret_prefix?: string | null;
  /** sha256(prior plaintext); used to co-sign during the grace window. */
  secondary_secret_hash?: string | null;
  /** Unix ms when the prior secret stops co-signing. */
  secondary_expires_at?: number | null;
  active: boolean;
  created_at: number;
  last_delivery_at: number | null;
  success_count: number;
  failure_count: number;
}

export const MIN_GRACE_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface DeliveryAttempt {
  attempt: number;
  at: number;
  status: number | null; // null = network error
  ok: boolean;
  duration_ms: number;
  error: string | null;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event: WebhookEvent;
  url: string;
  payload: unknown;
  created_at: number;
  finished_at: number | null;
  delivered: boolean;
  attempts: DeliveryAttempt[];
}

export interface NewEndpoint {
  record: WebhookEndpoint;
  secret: string; // returned exactly once
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "webhooks.json");
const MAX_DELIVERIES = 500;

interface Store {
  version: 1;
  endpoints: WebhookEndpoint[];
  deliveries: WebhookDelivery[];
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  if (!existsSync(STORE_PATH))
    return { version: 1, endpoints: [], deliveries: [] };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.endpoints) ||
      !Array.isArray(parsed.deliveries)
    ) {
      return { version: 1, endpoints: [], deliveries: [] };
    }
    return parsed;
  } catch {
    return { version: 1, endpoints: [], deliveries: [] };
  }
}

async function writeStore(s: Store): Promise<void> {
  ensureDir();
  // cap delivery log to most recent
  s.deliveries.sort((a, b) => b.created_at - a.created_at);
  if (s.deliveries.length > MAX_DELIVERIES) s.deliveries.length = MAX_DELIVERIES;
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, STORE_PATH);
}

function newId(prefix = ""): string {
  return prefix + randomBytes(8).toString("base64url").slice(0, 12);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const ALLOWED_EVENTS: readonly WebhookEvent[] = ["run.created", "test.ping"];

export function isValidUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function listEndpoints(): Promise<WebhookEndpoint[]> {
  const s = await readStore();
  return [...s.endpoints].sort((a, b) => b.created_at - a.created_at);
}

export async function getEndpoint(id: string): Promise<WebhookEndpoint | null> {
  const s = await readStore();
  return s.endpoints.find((e) => e.id === id) ?? null;
}

export interface CreateEndpointInput {
  name: string;
  url: string;
  events?: WebhookEvent[];
}

export async function createEndpoint(
  input: CreateEndpointInput,
): Promise<NewEndpoint> {
  const name = input.name.trim().slice(0, 80) || "untitled";
  if (!isValidUrl(input.url)) {
    throw new Error("invalid_url");
  }
  // Apply current workspace SSRF policy at create time so obvious targets
  // (loopback, RFC1918 literals, metadata IPs, disallowed hosts) are
  // rejected with a stable, actionable error code instead of failing later
  // on every delivery attempt.
  const policy = await effectiveWebhookSsrfPolicy();
  const pre = preflightUrl(input.url, policy);
  if (!pre.ok) {
    throw new Error(`ssrf_blocked:${pre.reason}`);
  }
  const events =
    input.events && input.events.length
      ? input.events.filter((e) => ALLOWED_EVENTS.includes(e))
      : (["run.created"] as WebhookEvent[]);
  const secret = "whsec_" + randomBytes(24).toString("base64url");
  const record: WebhookEndpoint = {
    id: newId("ep_"),
    name,
    url: input.url,
    events,
    secret_prefix: secret.slice(0, 12),
    secret_hash: sha256(secret),
    active: true,
    created_at: Date.now(),
    last_delivery_at: null,
    success_count: 0,
    failure_count: 0,
  };
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    s.endpoints.push(record);
    await writeStore(s);
  });
  await writeQueue;
  return { record, secret };
}

export async function deleteEndpoint(id: string): Promise<boolean> {
  let ok = false;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const before = s.endpoints.length;
    s.endpoints = s.endpoints.filter((e) => e.id !== id);
    ok = s.endpoints.length !== before;
    if (ok) await writeStore(s);
  });
  await writeQueue;
  return ok;
}

export async function setEndpointActive(
  id: string,
  active: boolean,
): Promise<WebhookEndpoint | null> {
  let out: WebhookEndpoint | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const e = s.endpoints.find((x) => x.id === id);
    if (!e) return;
    e.active = active;
    out = { ...e };
    await writeStore(s);
  });
  await writeQueue;
  return out;
}

/** Resolve the plaintext secret hash for signing, never the plaintext itself. */
export async function endpointSecretHash(id: string): Promise<string | null> {
  const s = await readStore();
  const e = s.endpoints.find((x) => x.id === id);
  return e ? e.secret_hash : null;
}

/**
 * Return active signing hashes for an endpoint:
 *   - primary: always present (or null if endpoint is missing)
 *   - secondary: the prior secret while its grace window is open;
 *     omitted entirely once `secondary_expires_at` is in the past.
 *
 * Expired secondary material is also purged from disk on read so a stale
 * secret cannot be revived by clock skew or process restart.
 */
export async function endpointSigningSecrets(
  id: string,
): Promise<{ primary: string; secondary: string | null } | null> {
  const s = await readStore();
  const e = s.endpoints.find((x) => x.id === id);
  if (!e) return null;
  const now = Date.now();
  let secondary: string | null = null;
  if (
    e.secondary_secret_hash &&
    e.secondary_expires_at &&
    e.secondary_expires_at > now
  ) {
    secondary = e.secondary_secret_hash;
  } else if (e.secondary_secret_hash || e.secondary_expires_at) {
    // Lazy GC: expired -> clear from disk.
    writeQueue = writeQueue.then(async () => {
      const s2 = await readStore();
      const e2 = s2.endpoints.find((x) => x.id === id);
      if (!e2) return;
      if (e2.secondary_expires_at && e2.secondary_expires_at > Date.now()) return;
      e2.secondary_secret_prefix = null;
      e2.secondary_secret_hash = null;
      e2.secondary_expires_at = null;
      await writeStore(s2);
    });
  }
  return { primary: e.secret_hash, secondary };
}

export interface RotateResult {
  record: WebhookEndpoint;
  /** Plaintext of the new secret. Returned exactly once. */
  secret: string;
  /** Unix ms when the prior secret stops co-signing. */
  secondary_expires_at: number;
}

/**
 * Rotate the signing secret for an endpoint.
 *
 * Generates a new plaintext, persists only the hash, and moves the current
 * secret into the secondary slot with `graceMs` lifetime. The new secret is
 * returned exactly once. If a previous rotation is still in flight the old
 * secondary is replaced (we only keep one prior secret at a time).
 */
export async function rotateEndpointSecret(
  id: string,
  graceMs: number = DEFAULT_GRACE_MS,
): Promise<RotateResult | null> {
  const grace = Math.max(MIN_GRACE_MS, Math.min(MAX_GRACE_MS, graceMs | 0));
  let out: RotateResult | null = null;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const e = s.endpoints.find((x) => x.id === id);
    if (!e) return;
    const newSecret = "whsec_" + randomBytes(24).toString("base64url");
    const now = Date.now();
    e.secondary_secret_prefix = e.secret_prefix;
    e.secondary_secret_hash = e.secret_hash;
    e.secondary_expires_at = now + grace;
    e.secret_prefix = newSecret.slice(0, 12);
    e.secret_hash = sha256(newSecret);
    e.secret_rotated_at = now;
    await writeStore(s);
    out = {
      record: { ...e },
      secret: newSecret,
      secondary_expires_at: e.secondary_expires_at,
    };
  });
  await writeQueue;
  return out;
}

/**
 * Immediately revoke the prior (secondary) secret, ending the grace window.
 * Returns true if a secondary existed and was cleared.
 */
export async function revokeEndpointSecondary(id: string): Promise<boolean> {
  let cleared = false;
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    const e = s.endpoints.find((x) => x.id === id);
    if (!e) return;
    if (!e.secondary_secret_hash && !e.secondary_expires_at) return;
    e.secondary_secret_prefix = null;
    e.secondary_secret_hash = null;
    e.secondary_expires_at = null;
    cleared = true;
    await writeStore(s);
  });
  await writeQueue;
  return cleared;
}

export async function recordDelivery(
  delivery: WebhookDelivery,
): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const s = await readStore();
    // upsert by id
    const idx = s.deliveries.findIndex((d) => d.id === delivery.id);
    if (idx === -1) s.deliveries.push(delivery);
    else s.deliveries[idx] = delivery;

    // update endpoint counters when finished
    if (delivery.finished_at) {
      const e = s.endpoints.find((x) => x.id === delivery.endpoint_id);
      if (e) {
        e.last_delivery_at = delivery.finished_at;
        if (delivery.delivered) e.success_count += 1;
        else e.failure_count += 1;
      }
    }
    await writeStore(s);
  });
  await writeQueue;
}

export type DeliveryStatusFilter = "all" | "ok" | "failed" | "pending";

export interface ListDeliveriesQuery {
  endpoint_id?: string;
  limit?: number;
  status?: DeliveryStatusFilter;
}

export function deliveryStatus(d: WebhookDelivery): "ok" | "failed" | "pending" {
  if (d.delivered) return "ok";
  if (d.finished_at) return "failed";
  return "pending";
}

export async function listDeliveries(
  q: ListDeliveriesQuery = {},
): Promise<WebhookDelivery[]> {
  const s = await readStore();
  const limit = Math.min(Math.max(q.limit ?? 50, 1), MAX_DELIVERIES);
  let items = [...s.deliveries];
  if (q.endpoint_id) items = items.filter((d) => d.endpoint_id === q.endpoint_id);
  if (q.status && q.status !== "all") {
    items = items.filter((d) => deliveryStatus(d) === q.status);
  }
  items.sort((a, b) => b.created_at - a.created_at);
  return items.slice(0, limit);
}

export async function getDelivery(id: string): Promise<WebhookDelivery | null> {
  const s = await readStore();
  return s.deliveries.find((d) => d.id === id) ?? null;
}

export function newDeliveryId(): string {
  return newId("del_");
}

export const __test = { sha256, ALLOWED_EVENTS, MAX_DELIVERIES };
