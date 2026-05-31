import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runs-share-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("runs-store sharing", () => {
  it("mints a token, looks the run up by token, and revokes", async () => {
    const store = await import("../lib/runs-store");

    const id = store.newRunId();
    await store.appendRun({
      id,
      created_at: Date.now(),
      kind: "demo",
      title: "Shareable run",
      summary: "test",
      user_id: "u1",
      latency_ms: 5,
      payload: { hello: "world" },
      tags: [],
    });

    // Initially not shared.
    let rec = await store.getRun(id);
    expect(rec).not.toBeNull();
    expect(rec?.share_token ?? null).toBeNull();

    // Enable sharing.
    const shared = await store.setRunShared(id, true);
    expect(shared).not.toBeNull();
    expect(typeof shared?.share_token).toBe("string");
    expect((shared?.share_token ?? "").length).toBeGreaterThanOrEqual(16);
    expect(shared?.shared_at).toBeTypeOf("number");

    // Toggling on again is idempotent (same token).
    const sharedAgain = await store.setRunShared(id, true);
    expect(sharedAgain?.share_token).toBe(shared?.share_token);

    // Look up by token works.
    const token = shared!.share_token!;
    const byToken = await store.getRunByShareToken(token);
    expect(byToken?.id).toBe(id);

    // Unknown token returns null.
    const missing = await store.getRunByShareToken("nope-nope-nope-nope");
    expect(missing).toBeNull();

    // Revoke.
    const revoked = await store.setRunShared(id, false);
    expect(revoked?.share_token ?? null).toBeNull();
    expect(revoked?.shared_at ?? null).toBeNull();

    // Token no longer resolves.
    const after = await store.getRunByShareToken(token);
    expect(after).toBeNull();
  });

  it("returns null for unknown id", async () => {
    const store = await import("../lib/runs-store");
    const r = await store.setRunShared("does-not-exist", true);
    expect(r).toBeNull();
  });
});
