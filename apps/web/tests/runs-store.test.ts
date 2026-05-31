import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runs-store-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("runs-store", () => {
  it("appends, lists, searches, updates, and deletes", async () => {
    // import after env is set so DATA_DIR resolves correctly
    const store = await import("../lib/runs-store");

    const id1 = store.newRunId();
    const id2 = store.newRunId();
    expect(id1).not.toEqual(id2);

    await store.appendRun({
      id: id1,
      created_at: Date.now() - 1000,
      kind: "predict",
      title: "predict alice",
      summary: "risk 42% medium",
      user_id: "alice",
      latency_ms: 12,
      payload: { ok: 1 },
      tags: ["batch1"],
    });
    await store.appendRun({
      id: id2,
      created_at: Date.now(),
      kind: "cohort",
      title: "cohort scan",
      summary: "10 users scored",
      user_id: null,
      latency_ms: 88,
      payload: { ok: 2 },
      tags: [],
    });

    const all = await store.listRuns();
    expect(all.total).toBe(2);
    expect(all.items[0].id).toBe(id2); // newest first

    const onlyPredict = await store.listRuns({ kind: "predict" });
    expect(onlyPredict.total).toBe(1);
    expect(onlyPredict.items[0].title).toBe("predict alice");

    const searched = await store.listRuns({ q: "alice" });
    expect(searched.total).toBe(1);

    const renamed = await store.updateRun(id1, { title: "renamed", tags: ["x", "y"] });
    expect(renamed?.title).toBe("renamed");
    expect(renamed?.tags).toEqual(["x", "y"]);

    const fetched = await store.getRun(id1);
    expect(fetched?.title).toBe("renamed");

    expect(await store.deleteRun(id2)).toBe(true);
    expect(await store.countRuns()).toBe(1);
    expect(await store.deleteRun("nope")).toBe(false);
  });
});
