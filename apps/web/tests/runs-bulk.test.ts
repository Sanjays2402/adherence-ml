import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runs-bulk-"));
  process.env.ADHERENCE_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

async function seed(n: number) {
  const store = await import("../lib/runs-store");
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = store.newRunId();
    ids.push(id);
    await store.appendRun({
      id,
      created_at: Date.now() + i,
      kind: "predict",
      title: `run ${i}`,
      summary: "",
      user_id: null,
      latency_ms: 5,
      payload: { i },
      tags: [],
    });
  }
  return { store, ids };
}

describe("runs-store bulk ops", () => {
  it("bulk deletes a subset and leaves the rest intact", async () => {
    const { store, ids } = await seed(5);
    const removed = await store.deleteRuns([ids[0], ids[2], ids[4], "nope"]);
    expect(removed).toBe(3);
    const remaining = await store.listRuns({ limit: 100 });
    expect(remaining.total).toBe(2);
    expect(remaining.items.map((r) => r.id).sort()).toEqual(
      [ids[1], ids[3]].sort(),
    );
  });

  it("bulk pins and unpins and counts only real changes", async () => {
    const { store, ids } = await seed(3);
    const pinned = await store.setRunsPinned(ids, true);
    expect(pinned).toBe(3);
    // re-applying pin=true is a no-op
    const again = await store.setRunsPinned(ids, true);
    expect(again).toBe(0);
    const unpin = await store.setRunsPinned([ids[0], ids[1]], false);
    expect(unpin).toBe(2);
    const list = await store.listRuns({ limit: 100, pinned: true });
    expect(list.total).toBe(1);
    expect(list.items[0].id).toBe(ids[2]);
  });

  it("returns 0 for empty id list without touching disk", async () => {
    const { store, ids } = await seed(1);
    expect(await store.deleteRuns([])).toBe(0);
    expect(await store.setRunsPinned([], true)).toBe(0);
    const list = await store.listRuns({ limit: 100 });
    expect(list.items.map((r) => r.id).sort()).toEqual([...ids].sort());
  });
});

describe("POST /api/runs/bulk", () => {
  it("validates the action enum", async () => {
    const mod = await import("../app/api/runs/bulk/route");
    const req = new Request("http://x/api/runs/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "nuke", ids: ["a"] }),
    });
    // @ts-expect-error NextRequest accepts plain Request in tests
    const res = await mod.POST(req);
    expect(res.status).toBe(422);
  });

  it("deletes the ids and reports affected count", async () => {
    const { ids } = await seed(4);
    const mod = await import("../app/api/runs/bulk/route");
    const req = new Request("http://x/api/runs/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete", ids: [ids[0], ids[1], ids[1]] }),
    });
    // @ts-expect-error NextRequest accepts plain Request in tests
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("delete");
    expect(body.affected).toBe(2);
    const store = await import("../lib/runs-store");
    const list = await store.listRuns({ limit: 100 });
    expect(list.total).toBe(2);
  });
});
