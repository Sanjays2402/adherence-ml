/**
 * v1 rate-limit helper: standard X-RateLimit-* + Retry-After.
 *
 * Asserts the contract the helper is supposed to give every /v1/* route:
 *   - one source of truth for limit / remaining / reset
 *   - 429 always carries Retry-After (real seconds to UTC midnight)
 *   - per-key cap is the binding ring when tighter than the plan ring
 *   - plan ring is the binding ring otherwise
 *   - read calls advertise headroom without consuming a unit
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-rl-"));
process.env.ADHERENCE_DATA_DIR = tmp;
// Generous plan ceiling so per-key cap can be the tighter ring.
process.env.ADHERENCE_FREE_DAILY_QUOTA = "10000";

const rl = await import("../lib/v1-ratelimit");
const usage = await import("../lib/usage-store");
const keyUsage = await import("../lib/api-key-usage-store");

beforeEach(async () => {
  for (const f of ["api-keys.json", "api-key-usage.jsonl", "usage.json"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_FREE_DAILY_QUOTA;
});

describe("v1-ratelimit", () => {
  it("Retry-After is positive seconds to next UTC midnight", () => {
    const secs = rl.secondsUntilUtcMidnight();
    expect(secs).toBeGreaterThan(0);
    expect(secs).toBeLessThanOrEqual(86400);
    const reset = rl.nextUtcMidnightEpoch();
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("plan ring is binding when there is no per-key cap", async () => {
    const b = await rl.readBudget({ id: "k_none", daily_quota: null });
    expect(b.scope).toBe("plan");
    expect(b.limit).toBe(10000);
    expect(b.key).toBeNull();
    const h = rl.rateLimitHeaders(b, 1);
    expect(h["x-ratelimit-limit"]).toBe("10000");
    expect(h["x-ratelimit-remaining"]).toBe("9999");
    expect(h["x-ratelimit-scope"]).toBe("plan");
    expect(Number(h["x-ratelimit-reset"])).toBeGreaterThan(0);
  });

  it("per-key cap becomes the binding ring when it is tighter than the plan", async () => {
    const b = await rl.readBudget({ id: "k_partner", daily_quota: 5 });
    expect(b.scope).toBe("api_key");
    expect(b.limit).toBe(5);
    expect(b.key).toEqual({ limit: 5, used: 0, remaining: 5 });
    const h = rl.rateLimitHeaders(b, 1);
    expect(h["x-ratelimit-limit"]).toBe("5");
    expect(h["x-ratelimit-remaining"]).toBe("4");
    expect(h["x-ratelimit-scope"]).toBe("api_key");
    expect(h["x-ratelimit-plan-limit"]).toBe("10000");
    expect(h["x-ratelimit-key-limit"]).toBe("5");
  });

  it("returns a 429 with Retry-After when the per-key ring is exhausted", async () => {
    const keyId = "k_burned";
    for (let i = 0; i < 5; i++) {
      await keyUsage.recordKeyUsage({
        key_id: keyId,
        ts: Date.now(),
        method: "POST",
        path: "/v1/predict",
        status: 200,
        latency_ms: 1,
      });
    }
    const b = await rl.readBudget({ id: keyId, daily_quota: 5 });
    expect(b.key?.used).toBe(5);
    expect(b.key?.remaining).toBe(0);
    const resp = rl.over429(b, 1);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(429);
    const retry = Number(resp!.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(86400);
    expect(resp!.headers.get("x-ratelimit-scope")).toBe("api_key");
    expect(resp!.headers.get("x-ratelimit-limit")).toBe("5");
    expect(resp!.headers.get("x-ratelimit-remaining")).toBe("0");
    const body = (await resp!.json()) as { scope: string; retry_after_seconds: number };
    expect(body.scope).toBe("api_key");
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it("returns a 429 when the plan ring is exhausted even with no per-key cap", () => {
    // Build a budget object directly so we don't have to stamp tens of
    // thousands of usage rows just to exhaust the plan ring.
    const reset = rl.nextUtcMidnightEpoch();
    const retry = rl.secondsUntilUtcMidnight();
    const exhausted = {
      limit: 100,
      remaining: 0,
      reset,
      retryAfter: retry,
      plan: { limit: 100, used: 100, remaining: 0 },
      key: null,
      burst: null,
      scope: "plan" as const,
    };
    const resp = rl.over429(exhausted, 1);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(429);
    expect(resp!.headers.get("retry-after")).toBe(String(retry));
    expect(resp!.headers.get("x-ratelimit-scope")).toBe("plan");
    expect(resp!.headers.get("x-ratelimit-limit")).toBe("100");
    expect(resp!.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("batch cost is checked atomically (rejects before partial spend)", async () => {
    const b = await rl.readBudget({ id: "k_batch", daily_quota: 10 });
    expect(rl.over429(b, 11)).not.toBeNull();
    expect(rl.over429(b, 10)).toBeNull();
  });
});
