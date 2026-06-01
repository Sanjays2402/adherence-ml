/**
 * Per-API-key burst rate limit enforcement.
 *
 * Proves that a key carrying burst_rpm=N starts returning 429 with the
 * "burst" scope as soon as N calls are charged inside a 60s window, even
 * when both the workspace plan quota and the per-key daily cap would
 * otherwise permit the call. Also proves the window slides: hits older
 * than 60s no longer count.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-burst-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_FREE_DAILY_QUOTA = "100000";

const rl = await import("../lib/v1-ratelimit");
const burst = await import("../lib/burst-ratelimit");

beforeEach(() => {
  burst._resetBurstState();
  for (const f of ["api-keys.json", "api-key-usage.jsonl", "usage.json"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) void fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("per-key burst rate limit", () => {
  it("429s with scope=burst once limit reached, even with daily headroom", async () => {
    const key = { id: "k_test_1", prefix: "ak_test1", daily_quota: 1000, burst_rpm: 3 };

    // 3 calls allowed, 4th tripped
    for (let i = 0; i < 3; i++) {
      const b = await rl.readBudget(key);
      expect(rl.over429(b)).toBeNull();
      burst.chargeBurst(key.id);
    }
    const b4 = await rl.readBudget(key);
    const resp = rl.over429(b4);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(429);
    expect(resp!.headers.get("x-ratelimit-scope")).toBe("burst");
    expect(resp!.headers.get("x-ratelimit-limit")).toBe("3");
    expect(resp!.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(resp!.headers.get("x-ratelimit-burst-limit")).toBe("3");
    expect(resp!.headers.get("x-ratelimit-burst-window")).toBe("60");
    const ra = Number(resp!.headers.get("retry-after"));
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(60);
    const body = await resp!.json();
    expect(body.scope).toBe("burst");
    expect(body.detail).toMatch(/burst/i);
  });

  it("does not apply when burst_rpm is null", async () => {
    const key = { id: "k_test_2", prefix: "ak_test2", daily_quota: 1000, burst_rpm: null };
    for (let i = 0; i < 50; i++) burst.chargeBurst(key.id);
    const b = await rl.readBudget(key);
    expect(rl.over429(b)).toBeNull();
    expect(b.burst).toBeNull();
  });

  it("slides: hits older than 60s no longer count", async () => {
    const key = { id: "k_test_3", prefix: "ak_test3", daily_quota: 1000, burst_rpm: 2 };
    const now = Date.now();
    burst.chargeBurst(key.id, 1, now - 65_000); // expired
    burst.chargeBurst(key.id, 1, now - 30_000); // counts
    const b = await rl.readBudget(key);
    expect(b.burst).not.toBeNull();
    expect(b.burst!.used).toBe(1);
    expect(b.burst!.remaining).toBe(1);
  });

  it("emits burst headers alongside plan headers on normal calls", async () => {
    const key = { id: "k_test_4", prefix: "ak_test4", daily_quota: null, burst_rpm: 10 };
    burst.chargeBurst(key.id, 2);
    const b = await rl.readBudget(key);
    const headers = rl.rateLimitHeaders(b, 0);
    expect(headers["x-ratelimit-burst-limit"]).toBe("10");
    expect(headers["x-ratelimit-burst-remaining"]).toBe("8");
    expect(headers["x-ratelimit-burst-window"]).toBe("60");
    expect(headers["x-ratelimit-plan-limit"]).toBeDefined();
  });
});
