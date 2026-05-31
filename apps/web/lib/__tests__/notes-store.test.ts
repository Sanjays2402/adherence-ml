/**
 * Smoke test for notes-store: create, list, soft-delete with author guard.
 * Run with: pnpm tsx lib/__tests__/notes-store.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "notes-"));
process.env.ADHERENCE_DATA_DIR = tmp;

function fail(msg: string): never {
  console.error("FAIL:", msg);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
function ok(cond: unknown, msg: string) {
  if (!cond) fail(msg);
}

async function main() {
  const { createNote, listNotesForRun, deleteNote, countNotesForRun } =
    await import("../notes-store");

  const runId = "run_abc";

  const n1 = await createNote({
    run_id: runId,
    body: "first note",
    user_id: "u_alice",
    author_email: "alice@example.com",
  });
  const n2 = await createNote({
    run_id: runId,
    body: "second note",
    user_id: "u_bob",
    author_email: "bob@example.com",
  });
  const n3 = await createNote({
    run_id: "run_other",
    body: "different run",
    user_id: "u_alice",
    author_email: "alice@example.com",
  });

  let list = await listNotesForRun(runId);
  ok(list.length === 2, `expected 2 notes for run, got ${list.length}`);
  ok(list[0].id === n1.id, "notes should be sorted oldest first");
  ok(list[1].id === n2.id, "second note position");

  const other = await listNotesForRun("run_other");
  ok(other.length === 1 && other[0].id === n3.id, "other run isolated");

  // Bob cannot delete Alice's note.
  const wrong = await deleteNote(n1.id, "u_bob");
  ok(wrong === false, "wrong user delete must be rejected");
  list = await listNotesForRun(runId);
  ok(list.length === 2, "note must survive unauthorized delete");

  // Alice can delete her own note.
  const right = await deleteNote(n1.id, "u_alice");
  ok(right === true, "owner delete must succeed");
  list = await listNotesForRun(runId);
  ok(list.length === 1 && list[0].id === n2.id, "note removed after delete");

  const c = await countNotesForRun(runId);
  ok(c === 1, `count expected 1, got ${c}`);

  // Empty body rejected.
  let threw = false;
  try {
    await createNote({
      run_id: runId,
      body: "   ",
      user_id: null,
      author_email: null,
    });
  } catch {
    threw = true;
  }
  ok(threw, "empty body must throw");

  rmSync(tmp, { recursive: true, force: true });
  console.log("OK notes-store");
}

main().catch((err) => {
  console.error(err);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
