import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-run-clone-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const runs = await import("../lib/runs-store");
const { cloneFromRun, isCloneable } = await import("../lib/run-clone");
const route = await import("../app/api/runs/[id]/clone/route");

beforeEach(async () => {
  // No reset hook on runs-store; tests use unique ids.
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

const samplePayload = {
  request: {
    user_id: "u_42",
    top_k_reasons: 5,
    schedule: [
      {
        dose_id: "d1",
        scheduled_at: "2025-06-01T08:00:00.000Z",
        dose_class: "cardio",
        dose_strength_mg: 10,
      },
      {
        dose_id: "d2",
        scheduled_at: "2025-06-01T20:00:00.000Z",
        dose_class: "psych",
        dose_strength_mg: 25,
      },
    ],
  },
  response: { risk: 0.42, top_reasons: [] },
};

describe("run-clone", () => {
  it("isCloneable accepts predict runs with a schedule", () => {
    expect(
      isCloneable({ kind: "predict", payload: samplePayload }),
    ).toBe(true);
  });

  it("isCloneable rejects unsupported kinds", () => {
    expect(
      isCloneable({ kind: "explain", payload: samplePayload }),
    ).toBe(false);
  });

  it("isCloneable rejects predict runs with no schedule", () => {
    expect(
      isCloneable({
        kind: "predict",
        payload: { request: { user_id: "x" }, response: {} },
      }),
    ).toBe(false);
  });

  it("cloneFromRun extracts user_id, top_k and rows", () => {
    const out = cloneFromRun({
      kind: "predict",
      payload: samplePayload,
      user_id: null,
    });
    expect(out).not.toBeNull();
    expect(out!.user_id).toBe("u_42");
    expect(out!.top_k).toBe(5);
    expect(out!.rows).toHaveLength(2);
    expect(out!.rows[0].dose_id).toBe("d1");
    expect(out!.rows[0].dose_class).toBe("cardio");
    expect(out!.rows[0].dose_strength_mg).toBe(10);
    // datetime-local format: YYYY-MM-DDTHH:mm (16 chars, no seconds)
    expect(out!.rows[0].scheduled_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("cloneFromRun clamps top_k_reasons into [0,50]", () => {
    const out = cloneFromRun({
      kind: "predict",
      payload: {
        request: { ...samplePayload.request, top_k_reasons: 99999 },
        response: {},
      },
      user_id: null,
    });
    expect(out!.top_k).toBe(50);
  });

  it("GET /api/runs/[id]/clone returns 404 for missing run", async () => {
    const res = await route.GET(new Request("http://x/api/runs/missing/clone"), {
      params: Promise.resolve({ id: "missing-id-xyz" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/runs/[id]/clone returns inputs for a real predict run", async () => {
    const id = runs.newRunId();
    await runs.appendRun({
      id,
      created_at: Date.now(),
      kind: "predict",
      title: "test predict",
      summary: "",
      user_id: "u_42",
      latency_ms: 12,
      payload: samplePayload,
      tags: [],
    });
    const res = await route.GET(new Request(`http://x/api/runs/${id}/clone`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_run_id).toBe(id);
    expect(body.inputs.user_id).toBe("u_42");
    expect(body.inputs.rows).toHaveLength(2);
  });

  it("GET /api/runs/[id]/clone returns 422 for non-cloneable kind", async () => {
    const id = runs.newRunId();
    await runs.appendRun({
      id,
      created_at: Date.now(),
      kind: "explain",
      title: "test explain",
      summary: "",
      user_id: null,
      latency_ms: 1,
      payload: { foo: "bar" },
      tags: [],
    });
    const res = await route.GET(new Request(`http://x/api/runs/${id}/clone`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(422);
  });
});
