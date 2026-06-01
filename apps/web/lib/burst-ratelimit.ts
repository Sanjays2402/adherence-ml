/**
 * Per-key per-minute burst rate limit.
 *
 * Why this exists: the workspace plan quota and the per-key daily quota
 * both reset at UTC midnight, which means a runaway client can burn a
 * whole day's budget in a few seconds and take down a production tenant.
 * Enterprise procurement reviews (and most SRE teams) want a small,
 * second-grain ring on top of the daily ring so a misbehaving client is
 * shed in real time without dropping the daily ceiling.
 *
 * Implementation is a rolling 60-second window kept in process memory.
 * That is intentionally simple: we do not need cross-instance
 * coordination for a self-host build, and the daily ring already gives
 * us the durable counter. If a process restarts, the worst case is one
 * extra burst-window's worth of headroom, which is strictly safer than
 * spuriously 429-ing on cold start.
 *
 * The limiter exposes the same shape that v1-ratelimit's `RateBudget`
 * uses (limit / used / remaining) so it composes cleanly with the
 * existing daily ring in headers and 429 payloads.
 */

const WINDOW_MS = 60_000;

/** Per-key ring buffer of recent call timestamps (epoch ms, ascending). */
const hits = new Map<string, number[]>();

/** Drop hits older than the rolling window. */
function trim(arr: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  // most calls only need to drop a small head; do it in place
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  return i === 0 ? arr : arr.slice(i);
}

export interface BurstRing {
  /** configured limit; 0 when the key has no per-minute cap */
  limit: number;
  /** calls counted in the last 60s */
  used: number;
  /** limit - used, never below 0; Infinity when uncapped */
  remaining: number;
  /** unix seconds when the oldest hit ages out, or now+1 when empty */
  reset: number;
  /** seconds until reset, always >= 1 */
  retryAfter: number;
}

/** Read the per-minute ring for a key without consuming a slot. */
export function readBurst(
  keyId: string,
  limit: number | null | undefined,
  now: number = Date.now(),
): BurstRing | null {
  if (!limit || limit <= 0) return null;
  const arr = trim(hits.get(keyId) ?? [], now);
  hits.set(keyId, arr);
  const used = arr.length;
  const oldest = arr[0] ?? now;
  const reset = Math.floor((oldest + WINDOW_MS) / 1000);
  const retryAfter = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    reset,
    retryAfter,
  };
}

/** Returns true when the next `cost` calls would breach the per-minute cap. */
export function wouldExceedBurst(
  ring: BurstRing | null,
  cost = 1,
): boolean {
  if (!ring) return false;
  return ring.used + cost > ring.limit;
}

/** Record `cost` calls against the per-minute ring for a key. */
export function chargeBurst(keyId: string, cost = 1, now: number = Date.now()): void {
  const arr = trim(hits.get(keyId) ?? [], now);
  for (let i = 0; i < cost; i++) arr.push(now);
  hits.set(keyId, arr);
}

/** Test helper: wipe all burst state. */
export function _resetBurstState(): void {
  hits.clear();
}
