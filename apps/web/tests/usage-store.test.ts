import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-usage-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_FREE_DAILY_QUOTA = "5";

const usage = await import("../lib/usage-store");

beforeEach(async () => {
  await usage._reset();
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_FREE_DAILY_QUOTA;
});

describe("usage-store", () => {
  it("starts at zero, records events, and counts today", async () => {
    expect(await usage.usedToday()).toBe(0);
    for (let i = 0; i < 3; i++) {
      await usage.recordUsage({
        ts: Date.now(),
        key_id: "k1",
        key_prefix: "adh_aaaa",
        status: 200,
        latency_ms: 12,
      });
    }
    expect(await usage.usedToday()).toBe(3);
  });

  it("summary returns 30 backfilled days with today's count and per-key breakdown", async () => {
    await usage.recordUsage({ ts: Date.now(), key_id: "k1", key_prefix: "adh_aaaa", status: 200, latency_ms: 5 });
    await usage.recordUsage({ ts: Date.now(), key_id: "k2", key_prefix: "adh_bbbb", status: 200, latency_ms: 5 });
    await usage.recordUsage({ ts: Date.now(), key_id: "k1", key_prefix: "adh_aaaa", status: 200, latency_ms: 5 });

    const s = await usage.summary();
    expect(s.days.length).toBe(30);
    expect(s.used_today).toBe(3);
    expect(s.used_30d).toBe(3);
    expect(s.quota).toBe(5);
    expect(s.remaining_today).toBe(2);
    expect(s.pct_today).toBeCloseTo(0.6, 5);
    expect(s.by_key_30d[0]).toEqual({ key_id: "k1", count: 2 });
    expect(s.by_key_30d[1]).toEqual({ key_id: "k2", count: 1 });
  });

  it("buckets older events by their own UTC date", async () => {
    const yesterday = Date.now() - 25 * 3600 * 1000;
    await usage.recordUsage({ ts: yesterday, key_id: "k1", key_prefix: "adh_aaaa", status: 200, latency_ms: 5 });
    await usage.recordUsage({ ts: Date.now(), key_id: "k1", key_prefix: "adh_aaaa", status: 200, latency_ms: 5 });
    expect(await usage.usedToday()).toBe(1);
    const s = await usage.summary();
    expect(s.used_30d).toBe(2);
  });
});
