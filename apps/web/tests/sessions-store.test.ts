/**
 * Active sessions store: per-session revoke + cross-tenant isolation.
 *
 * Proves:
 *   - listSessionsForUser is strictly scoped (no cross-user leakage)
 *   - revokeSession requires matching user_id (cross-tenant revoke denied)
 *   - revokeAllForUser keeps the caller's current sid alive
 *   - expired sessions stop verifying
 *   - purgeSessionsForUser drops everything (used by account erasure)
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-sessions-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/sessions-store");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("sessions-store", () => {
  it("issues sids and lists scoped by user", async () => {
    const a = await store.createSession({
      user_id: "user-a",
      expires_at: Date.now() + 60_000,
      ip: "10.0.0.1",
      user_agent: "Mozilla/5.0 (test)",
      label: "magic-link",
    });
    const b = await store.createSession({
      user_id: "user-b",
      expires_at: Date.now() + 60_000,
      ip: "10.0.0.2",
      user_agent: null,
      label: "sso",
    });
    expect(a.sid).not.toBe(b.sid);

    const listA = await store.listSessionsForUser("user-a");
    const listB = await store.listSessionsForUser("user-b");
    expect(listA.map((s) => s.sid)).toEqual([a.sid]);
    expect(listB.map((s) => s.sid)).toEqual([b.sid]);
  });

  it("refuses cross-tenant revoke", async () => {
    const victim = await store.createSession({
      user_id: "victim",
      expires_at: Date.now() + 60_000,
      ip: null,
      user_agent: null,
      label: "session",
    });
    const denied = await store.revokeSession(victim.sid, "attacker");
    expect(denied).toBe(false);
    const stillLive = await store.getSessionRecord(victim.sid);
    expect(stillLive?.sid).toBe(victim.sid);

    const ok = await store.revokeSession(victim.sid, "victim");
    expect(ok).toBe(true);
    expect(await store.getSessionRecord(victim.sid)).toBeNull();
  });

  it("revokeAllForUser keeps the supplied sid", async () => {
    const keep = await store.createSession({
      user_id: "user-c",
      expires_at: Date.now() + 60_000,
      ip: null,
      user_agent: null,
      label: "session",
    });
    const drop1 = await store.createSession({
      user_id: "user-c",
      expires_at: Date.now() + 60_000,
      ip: null,
      user_agent: null,
      label: "session",
    });
    const drop2 = await store.createSession({
      user_id: "user-c",
      expires_at: Date.now() + 60_000,
      ip: null,
      user_agent: null,
      label: "session",
    });
    const n = await store.revokeAllForUser("user-c", keep.sid);
    expect(n).toBe(2);
    expect((await store.getSessionRecord(keep.sid))?.sid).toBe(keep.sid);
    expect(await store.getSessionRecord(drop1.sid)).toBeNull();
    expect(await store.getSessionRecord(drop2.sid)).toBeNull();
  });

  it("expired sessions are not returned", async () => {
    const rec = await store.createSession({
      user_id: "user-d",
      expires_at: Date.now() - 1,
      ip: null,
      user_agent: null,
      label: "session",
    });
    expect(await store.getSessionRecord(rec.sid)).toBeNull();
  });

  it("purgeSessionsForUser removes every record for the user", async () => {
    await store.createSession({
      user_id: "user-e",
      expires_at: Date.now() + 60_000,
      ip: null,
      user_agent: null,
      label: "session",
    });
    const removed = await store.purgeSessionsForUser("user-e");
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await store.listSessionsForUser("user-e")).toEqual([]);
  });
});
