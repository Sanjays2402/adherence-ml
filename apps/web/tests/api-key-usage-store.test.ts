import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-key-usage-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/api-key-usage-store");

beforeEach(async () => {
  await store._resetUsageForTests();
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("api-key-usage-store", () => {
  it("records events and summarises per-key", async () => {
    const now = Date.now();
    await store.recordKeyUsage({
      key_id: "k1",
      ts: now,
      method: "POST",
      path: "/v1/predict",
      status: 200,
      latency_ms: 42,
    });
    await store.recordKeyUsage({
      key_id: "k1",
      ts: now - 1000,
      method: "GET",
      path: "/v1/runs",
      status: 200,
      latency_ms: 10,
    });
    await store.recordKeyUsage({
      key_id: "k1",
      ts: now - 2000,
      method: "POST",
      path: "/v1/predict",
      status: 429,
      latency_ms: 5,
    });
    // event for a different key should not leak in
    await store.recordKeyUsage({
      key_id: "k2",
      ts: now,
      method: "POST",
      path: "/v1/predict",
      status: 200,
      latency_ms: 1,
    });

    const s = await store.summarizeKeyUsage("k1");
    expect(s.total).toBe(3);
    expect(s.last_24h).toBe(3);
    expect(s.last_7d).toBe(3);
    expect(s.daily.length).toBe(14);
    expect(s.daily[s.daily.length - 1].count).toBe(3);

    const predict = s.by_endpoint.find((e) => e.path === "/v1/predict");
    expect(predict?.count).toBe(2);
    const runs = s.by_endpoint.find((e) => e.path === "/v1/runs");
    expect(runs?.count).toBe(1);

    const ok = s.by_status.find((r) => r.status === 200);
    expect(ok?.count).toBe(2);
    const tooMany = s.by_status.find((r) => r.status === 429);
    expect(tooMany?.count).toBe(1);

    // newest first
    expect(s.recent[0].ts).toBe(now);
    expect(s.recent[s.recent.length - 1].ts).toBe(now - 2000);
  });

  it("returns empty summary when a key has no events", async () => {
    const s = await store.summarizeKeyUsage("nope");
    expect(s.total).toBe(0);
    expect(s.last_24h).toBe(0);
    expect(s.last_7d).toBe(0);
    expect(s.by_endpoint).toEqual([]);
    expect(s.by_status).toEqual([]);
    expect(s.recent).toEqual([]);
    expect(s.daily.length).toBe(14);
    expect(s.daily.every((d) => d.count === 0)).toBe(true);
  });
});
