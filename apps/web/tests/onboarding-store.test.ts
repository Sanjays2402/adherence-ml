import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-onboard-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/onboarding-store");

beforeEach(async () => {
  const f = path.join(tmp, "onboarding.json");
  if (existsSync(f)) await fs.rm(f);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("onboarding-store", () => {
  it("returns empty defaults when no file exists", async () => {
    const s = await store.readOnboarding();
    expect(s.version).toBe(1);
    expect(s.completed).toEqual([]);
    expect(s.dismissed).toBe(false);
    expect(s.seeded_at).toBeNull();
  });

  it("markStep adds and removes steps without duplicates", async () => {
    await store.markStep("explore_demo", true);
    await store.markStep("explore_demo", true); // idempotent
    let s = await store.readOnboarding();
    expect(s.completed).toEqual(["explore_demo"]);

    await store.markStep("issue_key", true);
    s = await store.readOnboarding();
    // Order follows STEP_IDS, not insertion order.
    expect(s.completed).toEqual(["explore_demo", "issue_key"]);

    await store.markStep("explore_demo", false);
    s = await store.readOnboarding();
    expect(s.completed).toEqual(["issue_key"]);
  });

  it("rejects unknown step ids from a corrupted file", async () => {
    await fs.writeFile(
      path.join(tmp, "onboarding.json"),
      JSON.stringify({ version: 1, completed: ["bogus", "issue_key"] }),
      "utf8",
    );
    const s = await store.readOnboarding();
    expect(s.completed).toEqual(["issue_key"]);
  });

  it("setDismissed persists and progress reflects state", async () => {
    await store.setDismissed(true);
    const s = await store.readOnboarding();
    expect(s.dismissed).toBe(true);
    expect(store.progress(s)).toEqual({ done: 0, total: 3, pct: 0 });

    await store.markStep("explore_demo", true);
    await store.markStep("issue_key", true);
    await store.markStep("save_run", true);
    const full = await store.readOnboarding();
    expect(store.progress(full)).toEqual({ done: 3, total: 3, pct: 100 });
  });

  it("markSeeded stamps a timestamp", async () => {
    const before = Date.now();
    await store.markSeeded();
    const s = await store.readOnboarding();
    expect(s.seeded_at).not.toBeNull();
    expect(s.seeded_at!).toBeGreaterThanOrEqual(before);
  });

  it("tolerates a corrupt onboarding.json by falling back to defaults", async () => {
    await fs.writeFile(path.join(tmp, "onboarding.json"), "{not json", "utf8");
    const s = await store.readOnboarding();
    expect(s.completed).toEqual([]);
  });
});
