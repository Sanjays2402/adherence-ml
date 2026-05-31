/**
 * /v1/batch — public, key-authenticated batch scoring endpoint.
 * Covers the branches that do not require the upstream FastAPI predictor:
 * missing key, invalid key, missing scope, missing CSV columns.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-v1batch-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/api-keys-store");
const route = await import("../app/v1/batch/route");

type Init = {
  headers?: Record<string, string>;
  body?: string;
  search?: string;
};

function req({ headers = {}, body = "", search = "" }: Init = {}) {
  return new Request(`http://test/v1/batch${search}`, {
    method: "POST",
    headers,
    body,
  }) as unknown as Parameters<typeof route.POST>[0];
}

beforeEach(async () => {
  for (const f of ["api-keys.json", "runs.ndjson", "usage.ndjson", "plan.json"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("/v1/batch", () => {
  it("rejects requests without an api key", async () => {
    const res = await route.POST(req({ body: "ignored" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_api_key");
  });

  it("rejects unknown api keys", async () => {
    const res = await route.POST(
      req({
        headers: { authorization: "Bearer adh_not_a_real_key", "content-type": "text/csv" },
        body: "user_id,dose_id,scheduled_at,dose_class,dose_strength_mg\n",
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_api_key");
  });

  it("rejects keys without the predict scope", async () => {
    const { plaintext } = await store.createKey("read-only", ["read"]);
    const res = await route.POST(
      req({
        headers: { authorization: `Bearer ${plaintext}`, "content-type": "text/csv" },
        body: "user_id,dose_id,scheduled_at,dose_class,dose_strength_mg\nu_1,d_1,2025-01-01T08:00:00Z,cardio,20\n",
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; required_scope: string };
    expect(body.error).toBe("missing_scope");
    expect(body.required_scope).toBe("predict");
  });

  it("rejects empty CSV bodies", async () => {
    const { plaintext } = await store.createKey("predict-key", ["predict"]);
    const res = await route.POST(
      req({
        headers: { authorization: `Bearer ${plaintext}`, "content-type": "text/csv" },
        body: "",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("empty_csv");
  });

  it("rejects CSVs missing required columns", async () => {
    const { plaintext } = await store.createKey("predict-key", ["predict"]);
    const res = await route.POST(
      req({
        headers: { authorization: `Bearer ${plaintext}`, "content-type": "text/csv" },
        body: "user_id,dose_id\nu_1,d_1\n",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      detail: { missing: string[] };
    };
    expect(body.error).toBe("missing_columns");
    expect(body.detail.missing).toEqual(
      expect.arrayContaining(["scheduled_at", "dose_class", "dose_strength_mg"]),
    );
  });

  it("GET returns endpoint documentation", async () => {
    const res = route.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoint: string; required_columns: string[] };
    expect(body.endpoint).toBe("/v1/batch");
    expect(body.required_columns).toContain("user_id");
  });
});
