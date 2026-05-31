/**
 * /v1/runs CRUD — POST create, PATCH rename/retag, DELETE, plus the
 * /v1/runs/[id]/share toggle. Covers scope enforcement, validation,
 * not-found, and happy paths so the public API stays a real contract.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-v1runscrud-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const keys = await import("../lib/api-keys-store");
const runsStore = await import("../lib/runs-store");
const listRoute = await import("../app/v1/runs/route");
const idRoute = await import("../app/v1/runs/[id]/route");
const shareRoute = await import("../app/v1/runs/[id]/share/route");

function makeReq(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  return new Request(url, init) as unknown as Parameters<typeof idRoute.GET>[0];
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function seedRun(extra: Partial<Parameters<typeof runsStore.appendRun>[0]> = {}) {
  const id = runsStore.newRunId();
  await runsStore.appendRun({
    id,
    created_at: Date.now(),
    kind: "predict",
    title: "seed run",
    summary: "",
    user_id: "u1",
    latency_ms: 10,
    payload: { score: 0.5 },
    tags: ["a"],
    ...extra,
  });
  return id;
}

beforeEach(async () => {
  for (const f of ["api-keys.json", "runs.jsonl", "api-key-usage.jsonl"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("POST /v1/runs", () => {
  it("401 without a key", async () => {
    const res = await listRoute.POST(
      makeReq("http://test/v1/runs", {
        method: "POST",
        body: JSON.stringify({ kind: "predict", title: "x", payload: {} }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("403 when key lacks 'predict' scope", async () => {
    const { plaintext } = await keys.createKey("read-only", ["read"]);
    const res = await listRoute.POST(
      makeReq("http://test/v1/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ kind: "predict", title: "x", payload: {} }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("422 on missing required fields", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict"]);
    const res = await listRoute.POST(
      makeReq("http://test/v1/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ kind: "predict" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("201 creates a run and the run is fetchable", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict", "read"]);
    const res = await listRoute.POST(
      makeReq("http://test/v1/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({
          kind: "predict",
          title: "made via api",
          summary: "hello",
          payload: { risk: 0.42 },
          tags: ["api", "smoke"],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; url: string; kind: string };
    expect(body.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.url).toBe(`/history/${body.id}`);
    expect(body.kind).toBe("predict");

    const got = await runsStore.getRun(body.id);
    expect(got?.title).toBe("made via api");
    expect(got?.tags).toEqual(["api", "smoke"]);
  });
});

describe("PATCH /v1/runs/[id]", () => {
  it("403 when key lacks 'predict' scope", async () => {
    const { plaintext } = await keys.createKey("reader", ["read"]);
    const id = await seedRun();
    const res = await idRoute.PATCH(
      makeReq(`http://test/v1/runs/${id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ title: "nope" }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(403);
  });

  it("422 when body is empty (no title or tags)", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict"]);
    const id = await seedRun();
    const res = await idRoute.PATCH(
      makeReq(`http://test/v1/runs/${id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({}),
      }),
      ctx(id),
    );
    expect(res.status).toBe(422);
  });

  it("404 when run does not exist", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict"]);
    const res = await idRoute.PATCH(
      makeReq(`http://test/v1/runs/nope_nope_nope`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ title: "x" }),
      }),
      ctx("nope_nope_nope"),
    );
    expect(res.status).toBe(404);
  });

  it("200 renames and retags, dedupes tags", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict"]);
    const id = await seedRun({ title: "old", tags: ["a"] });
    const res = await idRoute.PATCH(
      makeReq(`http://test/v1/runs/${id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ title: "new title", tags: ["x", "x", " y "] }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; tags: string[]; updated: boolean };
    expect(body.title).toBe("new title");
    expect(body.tags).toEqual(["x", "y"]);
    expect(body.updated).toBe(true);

    const got = await runsStore.getRun(id);
    expect(got?.title).toBe("new title");
    expect(got?.tags).toEqual(["x", "y"]);
  });
});

describe("DELETE /v1/runs/[id]", () => {
  it("403 when key lacks 'predict' scope", async () => {
    const { plaintext } = await keys.createKey("reader", ["read"]);
    const id = await seedRun();
    const res = await idRoute.DELETE(
      makeReq(`http://test/v1/runs/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      ctx(id),
    );
    expect(res.status).toBe(403);
    // still there
    expect(await runsStore.getRun(id)).not.toBeNull();
  });

  it("404 when run does not exist", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict"]);
    const res = await idRoute.DELETE(
      makeReq("http://test/v1/runs/missing_id", {
        method: "DELETE",
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      ctx("missing_id"),
    );
    expect(res.status).toBe(404);
  });

  it("200 deletes the run", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict"]);
    const id = await seedRun();
    const res = await idRoute.DELETE(
      makeReq(`http://test/v1/runs/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      ctx(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; deleted: boolean };
    expect(body.id).toBe(id);
    expect(body.deleted).toBe(true);
    expect(await runsStore.getRun(id)).toBeNull();
  });
});

describe("POST /v1/runs/[id]/share", () => {
  it("403 when key lacks 'predict' scope", async () => {
    const { plaintext } = await keys.createKey("reader", ["read"]);
    const id = await seedRun();
    const res = await shareRoute.POST(
      makeReq(`http://test/v1/runs/${id}/share`, {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ enable: true }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(403);
  });

  it("422 when 'enable' is missing", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict"]);
    const id = await seedRun();
    const res = await shareRoute.POST(
      makeReq(`http://test/v1/runs/${id}/share`, {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({}),
      }),
      ctx(id),
    );
    expect(res.status).toBe(422);
  });

  it("mints then revokes a share link", async () => {
    const { plaintext } = await keys.createKey("writer", ["predict"]);
    const id = await seedRun();

    const mint = await shareRoute.POST(
      makeReq(`http://test/v1/runs/${id}/share`, {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ enable: true }),
      }),
      ctx(id),
    );
    expect(mint.status).toBe(200);
    const mintBody = (await mint.json()) as {
      shared: boolean;
      share_url: string | null;
      share_token: string | null;
    };
    expect(mintBody.shared).toBe(true);
    expect(mintBody.share_token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mintBody.share_url).toBe(`/share/${mintBody.share_token}`);

    const revoke = await shareRoute.POST(
      makeReq(`http://test/v1/runs/${id}/share`, {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ enable: false }),
      }),
      ctx(id),
    );
    expect(revoke.status).toBe(200);
    const revokeBody = (await revoke.json()) as {
      shared: boolean;
      share_url: string | null;
    };
    expect(revokeBody.shared).toBe(false);
    expect(revokeBody.share_url).toBeNull();
  });
});
