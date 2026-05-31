import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-v1-export-"));
process.env.ADHERENCE_DATA_DIR = tmp;

// import AFTER env is set so module-level DATA_DIR resolves to tmp
const runs = await import("../lib/runs-store");
const keys = await import("../lib/api-keys-store");
const route = await import("../app/v1/runs/export/route");

let plaintext = "";
let readOnlyPlaintext = "";

beforeAll(async () => {
  const k = await keys.createKey("test-export-key", ["read"]);
  plaintext = k.plaintext;
  const k2 = await keys.createKey("predict-only", ["predict"]);
  readOnlyPlaintext = k2.plaintext;

  const base = Date.now() - 1000;
  await runs.appendRun({
    id: "r1",
    created_at: base,
    kind: "predict",
    title: "Daily predict",
    summary: "10 doses scored",
    user_id: "alice",
    latency_ms: 22,
    payload: { hello: "world" },
    tags: ["nightly"],
  });
  await runs.appendRun({
    id: "r2",
    created_at: base + 500,
    kind: "demo",
    title: "demo run",
    summary: "showcase",
    user_id: "bob",
    latency_ms: 9,
    payload: { x: 1 },
    tags: ["demo"],
  });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

function makeReq(qs: string, headers: Record<string, string> = {}): any {
  const url = new URL("http://localhost/v1/runs/export" + qs);
  return {
    headers: new Headers(headers),
    nextUrl: url,
  };
}

describe("/v1/runs/export", () => {
  it("rejects requests with no api key", async () => {
    const res = await route.GET(makeReq("") as any);
    expect(res.status).toBe(401);
  });

  it("rejects keys that lack the read scope", async () => {
    const res = await route.GET(
      makeReq("", { authorization: `Bearer ${readOnlyPlaintext}` }) as any,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.required_scope).toBe("read");
  });

  it("returns JSON with slim, scope-safe rows by default", async () => {
    const res = await route.GET(
      makeReq("", { authorization: `Bearer ${plaintext}` }) as any,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-export-count")).toBe("2");
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.items[0]).toHaveProperty("id");
    expect(body.items[0]).toHaveProperty("created_at_iso");
    // raw payload must NOT leak in slim export
    expect(body.items[0]).not.toHaveProperty("payload");
  });

  it("emits CSV with a header row when format=csv", async () => {
    const res = await route.GET(
      makeReq("?format=csv", { authorization: `Bearer ${plaintext}` }) as any,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe(
      "id,created_at_iso,kind,title,summary,user_id,latency_ms,tags,shared",
    );
    expect(lines.length).toBe(3); // header + 2 rows
  });

  it("filters by kind", async () => {
    const res = await route.GET(
      makeReq("?kind=predict", { authorization: `Bearer ${plaintext}` }) as any,
    );
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].kind).toBe("predict");
  });

  it("rejects bad format", async () => {
    const res = await route.GET(
      makeReq("?format=xml", { authorization: `Bearer ${plaintext}` }) as any,
    );
    expect(res.status).toBe(422);
  });
});
