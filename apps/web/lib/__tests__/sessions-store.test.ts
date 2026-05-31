/**
 * Smoke + cross-user isolation tests for sessions-store.
 *
 * Proves:
 *   - create + list + getSessionRecord roundtrip
 *   - touchSession debounce
 *   - revokeSession refuses cross-user revocation (alice cannot revoke bob)
 *   - revokeSession hides the record from getSessionRecord on next read
 *   - revokeAllForUser respects keepSid
 *   - purgeSessionsForUser deletes only the target user's rows
 *
 * Run with: pnpm tsx lib/__tests__/sessions-store.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "sessions-"));
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
  const {
    createSession,
    getSessionRecord,
    touchSession,
    listSessionsForUser,
    revokeSession,
    revokeAllForUser,
    purgeSessionsForUser,
  } = await import("../sessions-store");

  const expires = Date.now() + 60 * 60 * 1000;

  // alice has two sessions; bob has one.
  const aliceA = await createSession({
    user_id: "u_alice",
    expires_at: expires,
    ip: "10.0.0.1",
    user_agent: "Mozilla/5.0 (Mac)",
    label: "magic-link",
  });
  const aliceB = await createSession({
    user_id: "u_alice",
    expires_at: expires,
    ip: "10.0.0.2",
    user_agent: "Mozilla/5.0 (iPhone)",
    label: "sso",
  });
  const bob = await createSession({
    user_id: "u_bob",
    expires_at: expires,
    ip: "10.0.0.9",
    user_agent: "curl/8",
    label: "magic-link",
  });

  ok(aliceA.sid && aliceB.sid && bob.sid, "sids should be issued");
  ok(aliceA.sid !== aliceB.sid, "sids must be unique");

  const aliceList = await listSessionsForUser("u_alice");
  ok(aliceList.length === 2, `alice should see 2 sessions, saw ${aliceList.length}`);
  ok(
    aliceList.every((s) => s.user_id === "u_alice"),
    "alice's list must not contain other users",
  );

  const fetched = await getSessionRecord(aliceA.sid);
  ok(fetched !== null, "getSessionRecord should return live record");
  ok(fetched!.ip === "10.0.0.1", "ip preserved");

  // touch debounce: a touch right after create should be a no-op (record
  // remains within the debounce window so last_seen_at does not advance).
  const before = fetched!.last_seen_at;
  await touchSession(aliceA.sid, "10.0.0.99", "Mozilla/5.0 (Mac)");
  const after = await getSessionRecord(aliceA.sid);
  ok(after!.last_seen_at === before, "touch should be debounced within 60s");
  ok(after!.ip === "10.0.0.1", "ip should not change inside debounce window");

  // cross-user revocation: alice tries to revoke bob's session.
  const stolen = await revokeSession(bob.sid, "u_alice");
  ok(stolen === false, "alice must NOT be able to revoke bob's session");
  const bobStill = await getSessionRecord(bob.sid);
  ok(bobStill !== null, "bob's session must remain live");

  // legitimate revoke: alice revokes her own session aliceB.
  const flipped = await revokeSession(aliceB.sid, "u_alice");
  ok(flipped === true, "alice should revoke her own session");
  const gone = await getSessionRecord(aliceB.sid);
  ok(gone === null, "revoked session must not be returned");
  const list2 = await listSessionsForUser("u_alice");
  ok(list2.length === 1, `after revoke alice should see 1 session, saw ${list2.length}`);

  // double-revoke is a no-op.
  const again = await revokeSession(aliceB.sid, "u_alice");
  ok(again === false, "double revoke should return false");

  // revokeAllForUser with keepSid keeps the kept session live.
  const n = await revokeAllForUser("u_alice", aliceA.sid);
  ok(n === 0, `nothing to revoke after only one is live, got ${n}`);
  const keptList = await listSessionsForUser("u_alice");
  ok(keptList.length === 1 && keptList[0]!.sid === aliceA.sid, "kept session survives");

  // purge alice; bob's row is untouched.
  const removed = await purgeSessionsForUser("u_alice");
  ok(removed >= 1, "purge should remove alice's rows");
  const bobAfterPurge = await getSessionRecord(bob.sid);
  ok(bobAfterPurge !== null, "bob's session must survive alice's purge");
  const aliceAfterPurge = await listSessionsForUser("u_alice");
  ok(aliceAfterPurge.length === 0, "alice should have no sessions after purge");

  console.log("PASS sessions-store: cross-user isolation + revoke + purge");
  rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => fail(String(e)));
