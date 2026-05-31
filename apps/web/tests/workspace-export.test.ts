import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-export-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("workspace export: GDPR bundle", () => {
  it("owner gets bundle with member runs only; cross-tenant runs are excluded", async () => {
    const ws = await import("../lib/workspaces-store");
    const runs = await import("../lib/runs-store");
    const exp = await import("../lib/workspace-export");

    // Owner workspace for Alice; Bob is provisioned as editor.
    const [alice] = await ws.listForUser("u_alice", "alice@acme.com");
    expect(alice.role).toBe("owner");

    const bob = await ws.provisionMember(alice.id, "bob@acme.com", "editor");
    if (typeof bob === "string") throw new Error("provision bob failed");
    const bobUserId = bob.user_id;

    // Mallory has her own workspace; she is NOT in Alice's workspace.
    await ws.listForUser("u_mallory", "mallory@evil.example");

    // Seed runs: 2 from Alice, 1 from Bob, 1 from Mallory.
    const now = Date.now();
    await runs.appendRun({
      id: "r1", created_at: now, kind: "predict", title: "alice 1",
      summary: "", user_id: "u_alice", latency_ms: 10, payload: {}, tags: [],
    });
    await runs.appendRun({
      id: "r2", created_at: now + 1, kind: "predict", title: "alice 2",
      summary: "", user_id: "u_alice", latency_ms: 10, payload: {}, tags: [],
    });
    await runs.appendRun({
      id: "r3", created_at: now + 2, kind: "predict", title: "bob",
      summary: "", user_id: bobUserId, latency_ms: 10, payload: {}, tags: [],
    });
    await runs.appendRun({
      id: "r4", created_at: now + 3, kind: "predict", title: "mallory secret",
      summary: "", user_id: "u_mallory", latency_ms: 10, payload: {}, tags: [],
    });

    const bundle = await exp.buildWorkspaceExport(alice.id, "u_alice");
    if (bundle === null || bundle === "forbidden") {
      throw new Error("expected bundle, got " + String(bundle));
    }

    // Only Alice + Bob runs land in Alice's workspace export.
    const ids = bundle.runs.map((r) => r.id).sort();
    expect(ids).toEqual(["r1", "r2", "r3"]);
    expect(bundle.runs.find((r) => r.id === "r4")).toBeUndefined();
    expect(bundle.manifest.counts.runs).toBe(3);
    expect(bundle.manifest.counts.members).toBe(2);
  });

  it("non-owner member is forbidden; non-member gets not-found", async () => {
    const ws = await import("../lib/workspaces-store");
    const exp = await import("../lib/workspace-export");

    const [alice] = await ws.listForUser("u_alice", "alice@acme.com");
    const bob = await ws.provisionMember(alice.id, "bob@acme.com", "editor");
    if (typeof bob === "string") throw new Error("provision bob failed");

    const bobAttempt = await exp.buildWorkspaceExport(alice.id, bob.user_id);
    expect(bobAttempt).toBe("forbidden");

    const strangerAttempt = await exp.buildWorkspaceExport(alice.id, "u_stranger");
    expect(strangerAttempt).toBe(null);
  });

  it("runsCsv escapes quotes and commas", async () => {
    const exp = await import("../lib/workspace-export");
    const csv = exp.runsCsv([
      {
        id: "r1",
        created_at: 1700000000000,
        kind: "predict",
        title: 'has "quotes", and commas',
        summary: "line1\nline2",
        user_id: "u_alice",
        latency_ms: 12,
        payload: {},
        tags: ["a", "b"],
      },
    ]);
    expect(csv.split("\r\n")[0]).toContain("id,created_at_iso,kind");
    expect(csv).toContain('"has ""quotes"", and commas"');
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain("a|b");
  });
});
