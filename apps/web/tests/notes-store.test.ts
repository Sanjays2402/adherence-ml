/**
 * Vitest wrapper for notes-store: create, list, soft-delete with author guard.
 * The bulk of the assertions also live in lib/__tests__/notes-store.test.ts
 * for the stdlib runner; this file makes them visible to `pnpm test`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "notes-vitest-"));

beforeAll(() => {
  process.env.ADHERENCE_DATA_DIR = tmp;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("notes-store", () => {
  it("creates, lists, scopes by run, and enforces author on delete", async () => {
    const { createNote, listNotesForRun, deleteNote, countNotesForRun } =
      await import("../lib/notes-store");

    const runId = "run_vitest";
    const n1 = await createNote({
      run_id: runId,
      body: "first",
      user_id: "u_alice",
      author_email: "alice@example.com",
    });
    await createNote({
      run_id: runId,
      body: "second",
      user_id: "u_bob",
      author_email: "bob@example.com",
    });
    await createNote({
      run_id: "run_other",
      body: "elsewhere",
      user_id: "u_alice",
      author_email: "alice@example.com",
    });

    const list = await listNotesForRun(runId);
    expect(list).toHaveLength(2);
    expect(list[0].body).toBe("first");

    const other = await listNotesForRun("run_other");
    expect(other).toHaveLength(1);

    // Wrong user cannot delete.
    expect(await deleteNote(n1.id, "u_bob")).toBe(false);
    expect(await countNotesForRun(runId)).toBe(2);

    // Owner can delete.
    expect(await deleteNote(n1.id, "u_alice")).toBe(true);
    expect(await countNotesForRun(runId)).toBe(1);
  });

  it("rejects empty bodies", async () => {
    const { createNote } = await import("../lib/notes-store");
    await expect(
      createNote({
        run_id: "x",
        body: "   ",
        user_id: null,
        author_email: null,
      }),
    ).rejects.toThrow();
  });
});
