/**
 * /v1/runs/[id] — public, key-authenticated single-run fetch.
 * Covers: missing key, invalid key, missing scope, invalid id,
 * not-found, and success (full payload included).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-v1runsid-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/api-keys-store");
const runsStore = await import("../lib/runs-store");
const route = await import("../app/v1/runs/[id]/route");

function req(id: string, headers: Record<string, string> = {}) {
  return new Request(`http://test/v1/runs/${id}`, {
    headers,
  }) as unknown as Parameters<typeof route.GET>[0];
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(async () => {
  for (const f of ["api-keys.json", "runs.jsonl"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("/v1/runs/[id]", () => {
  it("returns 401 when no key is presented", async () => {
    const res = await route.GET(req("anything"), ctx("anything"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/missing api key/i);
  });

  it("returns 401 when the key is unknown", async () => {
    const res = await route.GET(
      req("anything", { authorization: "Bearer adh_nope" }),
      ctx("anything"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the key lacks the 'read' scope", async () => {
    const { plaintext } = await store.createKey("predict-only", ["predict"]);
    const res = await route.GET(
      req("anything", { authorization: `Bearer ${plaintext}` }),
      ctx("anything"),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required_scope: string };
    expect(body.required_scope).toBe("read");
  });

  it("returns 400 on malformed run id", async () => {
    const { plaintext } = await store.createKey("read-key", ["read"]);
    const bad = "../../etc/passwd";
    const res = await route.GET(
      req(encodeURIComponent(bad), { authorization: `Bearer ${plaintext}` }),
      ctx(bad),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the run does not exist", async () => {
    const { plaintext } = await store.createKey("read-key", ["read"]);
    const res = await route.GET(
      req("not_a_real_id", { authorization: `Bearer ${plaintext}` }),
      ctx("not_a_real_id"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/not found/i);
  });

  it("returns 200 with the full run payload when authorised", async () => {
    const { plaintext } = await store.createKey("read-key", ["read"]);
    const id = runsStore.newRunId();
    const created_at = Date.now();
    await runsStore.appendRun({
      id,
      created_at,
      kind: "predict",
      title: "test run",
      summary: "unit-test seed",
      user_id: "u_test",
      latency_ms: 42,
      payload: { hello: "world", n: 7 },
      tags: ["unit", "test"],
    });

    const res = await route.GET(
      req(id, { "x-api-key": plaintext }),
      ctx(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      title: string;
      tags: string[];
      payload: { hello: string; n: number };
      shared: boolean;
      share_url: string | null;
    };
    expect(body.id).toBe(id);
    expect(body.kind).toBe("predict");
    expect(body.title).toBe("test run");
    expect(body.tags).toEqual(["unit", "test"]);
    expect(body.payload.hello).toBe("world");
    expect(body.payload.n).toBe(7);
    expect(body.shared).toBe(false);
    expect(body.share_url).toBeNull();

    // must not leak the plaintext key in the response
    expect(JSON.stringify(body)).not.toContain(plaintext);
  });
});
