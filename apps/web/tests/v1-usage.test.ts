/**
 * /v1/usage — key-authenticated quota introspection. Exercises:
 *   1. Missing key (401)
 *   2. Invalid key (401)
 *   3. Valid key without `read` scope (403)
 *   4. Valid `read` key (200) with rate-limit headers and 30-day window shape
 *   5. Recorded usage moves used_today / remaining_today
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-v1-usage-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_FREE_DAILY_QUOTA = "100";

const keys = await import("../lib/api-keys-store");
const usage = await import("../lib/usage-store");
const route = await import("../app/v1/usage/route");

function req(headers: Record<string, string> = {}) {
  return new Request("http://test/v1/usage", { headers }) as unknown as Parameters<
    typeof route.GET
  >[0];
}

beforeEach(async () => {
  for (const f of ["api-keys.json", "usage.json"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_FREE_DAILY_QUOTA;
});

describe("/v1/usage", () => {
  it("returns 401 when no key is presented", async () => {
    const res = await route.GET(req());
    expect(res.status).toBe(401);
  });

  it("returns 401 when the key is unknown", async () => {
    const res = await route.GET(req({ authorization: "Bearer adh_does_not_exist" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the key lacks the 'read' scope", async () => {
    const { plaintext } = await keys.createKey("predict-only", ["predict"]);
    const res = await route.GET(req({ authorization: `Bearer ${plaintext}` }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      required_scope: string;
      key_scopes: string[];
    };
    expect(body.required_scope).toBe("read");
    expect(body.key_scopes).toEqual(["predict"]);
  });

  it("returns 200 with rate-limit headers and a 30-day window", async () => {
    const { plaintext } = await keys.createKey("read-key", ["read"]);
    const res = await route.GET(req({ authorization: `Bearer ${plaintext}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("100");
    const reset = Number(res.headers.get("X-RateLimit-Reset"));
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const body = (await res.json()) as {
      quota: number;
      used_today: number;
      remaining_today: number;
      used_30d: number;
      days: Array<{ date: string; total: number }>;
      by_key_30d: Array<{ key_id: string; count: number }>;
    };
    expect(body.quota).toBe(100);
    expect(body.used_today).toBe(0);
    expect(body.remaining_today).toBe(100);
    expect(body.days).toHaveLength(30);
    // ascending dates, ISO
    for (const d of body.days) {
      expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof d.total).toBe("number");
    }
  });

  it("reflects recorded predict usage in the response", async () => {
    const { record, plaintext } = await keys.createKey("read-key", ["read"]);
    await usage.recordUsage({
      ts: Date.now(),
      key_id: record.id,
      key_prefix: record.prefix,
      status: 200,
      latency_ms: 11,
    });
    await usage.recordUsage({
      ts: Date.now(),
      key_id: record.id,
      key_prefix: record.prefix,
      status: 200,
      latency_ms: 12,
    });
    const res = await route.GET(req({ authorization: `Bearer ${plaintext}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      used_today: number;
      remaining_today: number;
      by_key_30d: Array<{ key_id: string; count: number }>;
    };
    expect(body.used_today).toBe(2);
    expect(body.remaining_today).toBe(98);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("98");
    const mine = body.by_key_30d.find((r) => r.key_id === record.id);
    expect(mine?.count).toBe(2);
  });
});
