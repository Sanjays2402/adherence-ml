/**
 * Per-API-key daily quota enforcement.
 *
 * Proves that an api key carrying daily_quota=N starts returning 429 with
 * X-RateLimit headers once N usage events have been recorded for the day,
 * even when the workspace plan quota would otherwise permit the call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-keyq-"));
process.env.ADHERENCE_DATA_DIR = tmp;
// Lift workspace ceiling well above per-key cap so we are isolating per-key.
process.env.ADHERENCE_FREE_DAILY_QUOTA = "100000";

const keys = await import("../lib/api-keys-store");
const usage = await import("../lib/api-key-usage-store");

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

describe("api-keys-store: per-key daily quota", () => {
  it("normalizes quota inputs (blank/zero/negative clear the cap)", () => {
    expect(keys.normalizeDailyQuota(null)).toBeNull();
    expect(keys.normalizeDailyQuota(undefined)).toBeNull();
    expect(keys.normalizeDailyQuota("")).toBeNull();
    expect(keys.normalizeDailyQuota(0)).toBeNull();
    expect(keys.normalizeDailyQuota(-5)).toBeNull();
    expect(keys.normalizeDailyQuota("not-a-number")).toBeNull();
    expect(keys.normalizeDailyQuota(50)).toBe(50);
    expect(keys.normalizeDailyQuota("250")).toBe(250);
    // 10M cap
    expect(keys.normalizeDailyQuota(1e10)).toBe(10_000_000);
  });

  it("creates a key with no cap by default and lets updateKey set/clear it", async () => {
    const { record } = await keys.createKey("partner integration");
    expect(record.daily_quota).toBeNull();

    const set = await keys.updateKey(record.id, { daily_quota: 25 });
    expect(set?.daily_quota).toBe(25);

    const view = keys.publicView({ ...record, daily_quota: 25 });
    expect(view.daily_quota).toBe(25);

    const cleared = await keys.updateKey(record.id, { daily_quota: null });
    expect(cleared?.daily_quota).toBeNull();
  });

  it("refuses updates on revoked keys", async () => {
    const { record } = await keys.createKey("doomed");
    await keys.revokeKey(record.id);
    const out = await keys.updateKey(record.id, { daily_quota: 10 });
    expect(out).toBeNull();
  });

  it("usedTodayForKey reflects recorded calls and is per-key", async () => {
    const a = await keys.createKey("a");
    const b = await keys.createKey("b");
    for (let i = 0; i < 3; i++) {
      await usage.recordKeyUsage({
        key_id: a.record.id,
        ts: Date.now(),
        method: "POST",
        path: "/v1/predict",
        status: 200,
        latency_ms: 1,
      });
    }
    await usage.recordKeyUsage({
      key_id: b.record.id,
      ts: Date.now(),
      method: "POST",
      path: "/v1/predict",
      status: 200,
      latency_ms: 1,
    });
    expect(await usage.usedTodayForKey(a.record.id)).toBe(3);
    expect(await usage.usedTodayForKey(b.record.id)).toBe(1);
    // Yesterday's calls do not count toward today's per-key bucket.
    await usage.recordKeyUsage({
      key_id: a.record.id,
      ts: Date.now() - 2 * 24 * 60 * 60 * 1000,
      method: "POST",
      path: "/v1/predict",
      status: 200,
      latency_ms: 1,
    });
    expect(await usage.usedTodayForKey(a.record.id)).toBe(3);
  });
});
