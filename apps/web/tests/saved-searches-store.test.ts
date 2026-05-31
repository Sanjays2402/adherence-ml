import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-saved-search-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/saved-searches-store");

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("saved-searches-store", () => {
  it("creates, lists, renames, deletes scoped to a user", async () => {
    const created = await store.createSavedSearch({
      user_id: "u1",
      name: "Pinned predicts",
      filters: {
        q: "alice",
        kind: "predict",
        from: "2025-01-01",
        to: "2025-12-31",
        tags: ["urgent", "vip"],
        pinned_only: true,
      },
    });
    expect(created.id).toMatch(/^ss_/);
    expect(created.filters.tags).toEqual(["urgent", "vip"]);

    // isolation: another user sees nothing
    expect(await store.listSavedSearches("u2")).toHaveLength(0);

    const listed = await store.listSavedSearches("u1");
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("Pinned predicts");

    const renamed = await store.renameSavedSearch(
      "u1",
      created.id,
      "Top urgent cases",
    );
    expect(renamed?.name).toBe("Top urgent cases");

    // wrong user cannot rename or delete
    expect(await store.renameSavedSearch("u2", created.id, "x")).toBeNull();
    expect(await store.deleteSavedSearch("u2", created.id)).toBe(false);

    const removed = await store.deleteSavedSearch("u1", created.id);
    expect(removed).toBe(true);
    expect(await store.listSavedSearches("u1")).toHaveLength(0);
  });

  it("normalizes garbage filter input safely", () => {
    const out = store.normalizeFilters({
      // @ts-expect-error testing runtime guard
      kind: "not-a-kind",
      q: "x".repeat(500),
      from: "garbage",
      to: "2025-06-01",
      tags: Array.from({ length: 50 }, (_, i) => "t" + i),
      pinned_only: 1 as unknown as boolean,
    });
    expect(out.kind).toBe("all");
    expect(out.q.length).toBeLessThanOrEqual(200);
    expect(out.from).toBe("");
    expect(out.to).toBe("2025-06-01");
    expect(out.tags).toHaveLength(12);
    expect(out.pinned_only).toBe(true);
  });
});
