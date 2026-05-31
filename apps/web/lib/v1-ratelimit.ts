/**
 * v1 rate limit helper.
 *
 * Single source of truth for the standard rate-limit headers we emit on
 * every /v1/* response and the 429 we return when a caller is over budget.
 *
 * Why this exists: enterprise procurement reviews expect IETF-style
 * `X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset` headers
 * on every billable response, and a `Retry-After` header on 429s with the
 * real seconds until the quota window resets (not a hard-coded 3600).
 * Before this helper, each route invented its own headers and a few
 * routes (read-only ones) emitted nothing at all, so SDKs could not back
 * off correctly. This module fixes that.
 *
 * Two limits stack:
 *   - the workspace plan quota (recordUsage / usedToday)
 *   - the optional per-API-key daily quota (key.daily_quota)
 *
 * The tighter of the two is the *binding* limit and that is what the
 * standard `X-RateLimit-*` headers report. We also emit the granular
 * `X-RateLimit-Plan-*` and `X-RateLimit-Key-*` headers so multi-tenant
 * dashboards can show both rings on the same response. The 429 payload
 * names the scope that tripped so SDKs can surface the right message.
 *
 * All numbers are integers. `Reset` is unix seconds (UTC day rollover).
 * `Retry-After` is integer seconds, never negative, never zero.
 */
import { NextResponse } from "next/server";
import type { ApiKeyRecord } from "./api-keys-store";
import { FREE_DAILY_QUOTA, recordUsage, usedToday } from "./usage-store";
import { recordKeyUsage, usedTodayForKey } from "./api-key-usage-store";
import { dailyQuota as planDailyQuota } from "./plan-store";

export interface RateBudget {
  /** binding limit (min of plan, per-key) for the standard headers */
  limit: number;
  /** binding remaining BEFORE this call is counted */
  remaining: number;
  /** unix seconds when the binding window resets */
  reset: number;
  /** seconds until reset, always >= 1 */
  retryAfter: number;
  /** plan-level ring */
  plan: { limit: number; used: number; remaining: number };
  /** per-key ring; null when the key has no per-key cap */
  key: { limit: number; used: number; remaining: number } | null;
  /** which ring is the binding one */
  scope: "plan" | "api_key";
}

/** Seconds remaining until the next UTC midnight, minimum 1. */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/** Unix seconds when the next UTC midnight occurs. */
export function nextUtcMidnightEpoch(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) + secondsUntilUtcMidnight(now);
}

/**
 * Read both rings (plan + per-key) without consuming anything. Use this
 * on read endpoints (GET) that should advertise headroom without
 * charging the caller.
 */
export async function readBudget(
  key: Pick<ApiKeyRecord, "id" | "daily_quota">,
  now: Date = new Date(),
): Promise<RateBudget> {
  const planLimit = await planDailyQuota().catch(() => FREE_DAILY_QUOTA);
  const planUsed = await usedToday().catch(() => 0);
  const planRemaining = Math.max(0, planLimit - planUsed);

  const perKeyLimit =
    typeof key.daily_quota === "number" && key.daily_quota > 0
      ? key.daily_quota
      : null;
  const perKeyUsed = perKeyLimit !== null ? await usedTodayForKey(key.id).catch(() => 0) : 0;
  const perKeyRemaining = perKeyLimit !== null ? Math.max(0, perKeyLimit - perKeyUsed) : Infinity;

  const reset = nextUtcMidnightEpoch(now);
  const retryAfter = secondsUntilUtcMidnight(now);

  if (perKeyLimit !== null && perKeyLimit - perKeyUsed <= planLimit - planUsed) {
    return {
      limit: perKeyLimit,
      remaining: perKeyRemaining,
      reset,
      retryAfter,
      plan: { limit: planLimit, used: planUsed, remaining: planRemaining },
      key: { limit: perKeyLimit, used: perKeyUsed, remaining: perKeyRemaining },
      scope: "api_key",
    };
  }
  return {
    limit: planLimit,
    remaining: planRemaining,
    reset,
    retryAfter,
    plan: { limit: planLimit, used: planUsed, remaining: planRemaining },
    key:
      perKeyLimit !== null
        ? { limit: perKeyLimit, used: perKeyUsed, remaining: perKeyRemaining }
        : null,
    scope: "plan",
  };
}

/**
 * Build the standard rate-limit headers. `consumed` is the number of
 * units this call is about to charge against both rings (typically 1,
 * or N for batch). Pass 0 for pure read endpoints.
 */
export function rateLimitHeaders(b: RateBudget, consumed = 0): Record<string, string> {
  const planRemainingAfter = Math.max(0, b.plan.remaining - consumed);
  const keyRemainingAfter =
    b.key === null ? null : Math.max(0, b.key.remaining - consumed);
  const bindingRemainingAfter =
    b.scope === "api_key" && keyRemainingAfter !== null
      ? keyRemainingAfter
      : planRemainingAfter;

  const h: Record<string, string> = {
    // Standard IETF-style headers, lowercased for HTTP/2 friendliness.
    "x-ratelimit-limit": String(b.limit),
    "x-ratelimit-remaining": String(bindingRemainingAfter),
    "x-ratelimit-reset": String(b.reset),
    "x-ratelimit-scope": b.scope,
    // Granular rings so dashboards can show both at once.
    "x-ratelimit-plan-limit": String(b.plan.limit),
    "x-ratelimit-plan-remaining": String(planRemainingAfter),
  };
  if (b.key !== null && keyRemainingAfter !== null) {
    h["x-ratelimit-key-limit"] = String(b.key.limit);
    h["x-ratelimit-key-remaining"] = String(keyRemainingAfter);
  }
  return h;
}

/**
 * If the call would exceed either ring, return a fully-formed 429 with
 * standard headers (including `Retry-After`). Otherwise return null and
 * the caller proceeds.
 *
 * `cost` lets batch routes pre-check N units in one shot so we never
 * spend half a batch before bailing.
 */
export function over429(b: RateBudget, cost = 1): NextResponse | null {
  const keyOver = b.key !== null && b.key.used + cost > b.key.limit;
  const planOver = b.plan.used + cost > b.plan.limit;
  if (!keyOver && !planOver) return null;

  const scope: "plan" | "api_key" = keyOver ? "api_key" : "plan";
  const headers: Record<string, string> = {
    ...rateLimitHeaders(b, 0),
    "retry-after": String(b.retryAfter),
  };
  // When the binding scope is the one we just tripped, force remaining=0
  // (the helper above clamps to >=0 but a partial batch might have a
  // non-zero remaining; the 429 should always claim 0 on the tripped ring).
  if (scope === "api_key") {
    headers["x-ratelimit-scope"] = "api_key";
    headers["x-ratelimit-limit"] = String(b.key!.limit);
    headers["x-ratelimit-remaining"] = "0";
  } else {
    headers["x-ratelimit-scope"] = "plan";
    headers["x-ratelimit-limit"] = String(b.plan.limit);
    headers["x-ratelimit-remaining"] = "0";
  }

  return NextResponse.json(
    {
      detail:
        scope === "api_key"
          ? "per-key daily quota exceeded"
          : "daily plan quota exceeded",
      scope,
      limit: scope === "api_key" ? b.key!.limit : b.plan.limit,
      used_today: scope === "api_key" ? b.key!.used : b.plan.used,
      remaining: 0,
      reset: b.reset,
      retry_after_seconds: b.retryAfter,
      upgrade_url: "/pricing",
    },
    { status: 429, headers },
  );
}

/**
 * Record one call against both rings. Best-effort: bookkeeping failure
 * must never break the user-facing response.
 */
export async function chargeCall(opts: {
  key: Pick<ApiKeyRecord, "id" | "prefix">;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  cost?: number;
}): Promise<void> {
  const { key, method, path, status, latencyMs } = opts;
  const cost = opts.cost ?? 1;
  // Plan ring: usage-store is one event per call. For batch (cost>1) we
  // record `cost` events so the daily counter and the per-key counter
  // stay aligned with what the caller was actually charged.
  for (let i = 0; i < cost; i++) {
    try {
      await recordUsage({
        ts: Date.now(),
        key_id: key.id,
        key_prefix: key.prefix,
        status,
        latency_ms: latencyMs,
      });
    } catch {
      // bookkeeping must never break the call
    }
  }
  void recordKeyUsage({
    key_id: key.id,
    ts: Date.now(),
    method,
    path,
    status,
    latency_ms: latencyMs,
  }).catch(() => {});
}
