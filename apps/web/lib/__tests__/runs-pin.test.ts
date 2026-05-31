/**
 * Smoke test for runs-store pin/unpin behavior.
 *
 * Verifies:
 *   1. setRunPinned(id, true) flips the flag and stamps pinned_at.
 *   2. listRuns sorts pinned runs first regardless of created_at.
 *   3. listRuns({ pinned: true }) filters to pinned runs only.
 *   4. setRunPinned(id, false) clears the flag and pinned_at.
 *
 * Uses a throwaway ADHERENCE_DATA_DIR so it never touches real data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "runs-pin-"));
process.env.ADHERENCE_DATA_DIR = tmp;

// Import AFTER env is set so the module picks up our temp dir.
// Using dynamic import because static imports are hoisted by TS/ESM.
let appendRun: typeof import("../runs-store").appendRun;
let countPinned: typeof import("../runs-store").countPinned;
let listRuns: typeof import("../runs-store").listRuns;
let newRunId: typeof import("../runs-store").newRunId;
let setRunPinned: typeof import("../runs-store").setRunPinned;
type RunRecord = import("../runs-store").RunRecord;

function fail(msg: string): never {
  console.error("FAIL:", msg);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
function ok(cond: unknown, msg: string) {
  if (!cond) fail(msg);
}

async function main() {
  const mod = await import("../runs-store");
  appendRun = mod.appendRun;
  countPinned = mod.countPinned;
  listRuns = mod.listRuns;
  newRunId = mod.newRunId;
  setRunPinned = mod.setRunPinned;

  const base: Omit<RunRecord, "id" | "created_at"> = {
    kind: "predict",
    title: "",
    summary: "",
    user_id: null,
    latency_ms: null,
    payload: {},
    tags: [],
  };

  // Three runs, oldest -> newest by created_at.
  const older: RunRecord = { ...base, id: newRunId(), created_at: 1_000, title: "older" };
  const middle: RunRecord = { ...base, id: newRunId(), created_at: 2_000, title: "middle" };
  const newer: RunRecord = { ...base, id: newRunId(), created_at: 3_000, title: "newest" };
  await appendRun(older);
  await appendRun(middle);
  await appendRun(newer);

  // Default sort: newest first.
  let res = await listRuns({});
  ok(res.items[0].id === newer.id, `default sort newest first, got ${res.items[0].title}`);

  // Pin the OLDEST run; it should float to the top of the default listing.
  const pinned = await setRunPinned(older.id, true);
  ok(pinned?.pinned === true, "pinned flag should be true");
  ok(typeof pinned?.pinned_at === "number", "pinned_at should be a number");

  res = await listRuns({});
  ok(
    res.items[0].id === older.id,
    `pinned run should sort first, got ${res.items[0].title}`,
  );
  ok(res.total === 3, `total still 3, got ${res.total}`);

  // pinned=true filter narrows the result.
  res = await listRuns({ pinned: true });
  ok(res.total === 1 && res.items[0].id === older.id, "pinned filter should return only pinned");

  const pc = await countPinned();
  ok(pc === 1, `countPinned should be 1, got ${pc}`);

  // Unpin restores default order.
  const unpinned = await setRunPinned(older.id, false);
  ok(unpinned?.pinned === false, "pinned flag should clear");
  ok(unpinned?.pinned_at === null, "pinned_at should clear");

  res = await listRuns({});
  ok(res.items[0].id === newer.id, "after unpin, newest first again");

  rmSync(tmp, { recursive: true, force: true });
  console.log("OK runs-pin");
}

main().catch((err) => {
  console.error(err);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
