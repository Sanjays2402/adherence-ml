import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-retention-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";

const users = await import("../lib/users-store");
const ws = await import("../lib/workspaces-store");
const runs = await import("../lib/runs-store");
const retention = await import("../lib/retention");

beforeAll(async () => {
  for (const f of ["users.json", "workspaces.json", "runs.jsonl"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_SESSION_SECRET;
});

async function makeUser(email: string) {
  const { token } = await users.issueMagicToken(email);
  const u = await users.consumeMagicToken(token);
  if (!u) throw new Error("user not minted");
  await ws.listForUser(u.id, u.email);
  return u;
}

function fakeRun(userId: string, createdAt: number, id: string) {
  return runs.appendRun({
    id,
    created_at: createdAt,
    kind: "predict",
    title: "t",
    summary: "s",
    user_id: userId,
    latency_ms: 1,
    payload: { foo: 1 },
    tags: [],
  });
}

describe("workspace retention enforcement", () => {
  it("normalizes retention day inputs", () => {
    expect(ws.normalizeRetentionDays(null)).toBe(null);
    expect(ws.normalizeRetentionDays(0)).toBe(null);
    expect(ws.normalizeRetentionDays(-5)).toBe(null);
    expect(ws.normalizeRetentionDays(7)).toBe(7);
    expect(ws.normalizeRetentionDays("30")).toBe(30);
    expect(ws.normalizeRetentionDays(999999)).toBe(3650);
    expect(ws.normalizeRetentionDays("not a number")).toBe(null);
  });

  it("does nothing when no policy is set", async () => {
    const u = await makeUser("a@reten.test");
    const myWs = (await ws.listForUser(u.id, u.email))[0]!;
    await fakeRun(u.id, Date.now() - 500 * 86_400_000, "old-no-policy-1");
    const res = await retention.enforceRetention(myWs.id);
    expect(res.retention_days).toBe(null);
    expect(res.deleted_count).toBe(0);
    const found = await runs.getRun("old-no-policy-1");
    expect(found).not.toBeNull();
  });

  it("purges runs older than the retention cutoff", async () => {
    const u = await makeUser("b@reten.test");
    const myWs = (await ws.listForUser(u.id, u.email))[0]!;
    await ws.setWorkspacePolicy(myWs.id, u.id, {
      session_max_age_minutes: null,
      require_mfa: false,
      runs_retention_days: 30,
    });
    const now = Date.now();
    await fakeRun(u.id, now - 60 * 86_400_000, "stale-1");
    await fakeRun(u.id, now - 45 * 86_400_000, "stale-2");
    await fakeRun(u.id, now - 5 * 86_400_000, "fresh-1");
    const res = await retention.enforceRetention(myWs.id);
    expect(res.retention_days).toBe(30);
    expect(res.deleted_count).toBe(2);
    expect(await runs.getRun("stale-1")).toBeNull();
    expect(await runs.getRun("stale-2")).toBeNull();
    expect(await runs.getRun("fresh-1")).not.toBeNull();
  });

  it("is cross-tenant safe: a tick for workspace A never touches workspace B runs", async () => {
    const alice = await makeUser("alice@reten.test");
    const bob = await makeUser("bob@reten.test");
    const aliceWs = (await ws.listForUser(alice.id, alice.email))[0]!;
    const bobWs = (await ws.listForUser(bob.id, bob.email))[0]!;
    // Alice has aggressive 1-day retention. Bob has none.
    await ws.setWorkspacePolicy(aliceWs.id, alice.id, {
      session_max_age_minutes: null,
      require_mfa: false,
      runs_retention_days: 1,
    });
    const now = Date.now();
    // Both users have an ancient run.
    await fakeRun(alice.id, now - 30 * 86_400_000, "alice-old");
    await fakeRun(bob.id, now - 30 * 86_400_000, "bob-old");
    // Ticking Alice's workspace must purge Alice's but never Bob's.
    const res = await retention.enforceRetention(aliceWs.id);
    expect(res.deleted_count).toBe(1);
    expect(await runs.getRun("alice-old")).toBeNull();
    expect(await runs.getRun("bob-old")).not.toBeNull();
    // Ticking Bob's workspace deletes nothing (no policy).
    const res2 = await retention.enforceRetention(bobWs.id);
    expect(res2.deleted_count).toBe(0);
    expect(await runs.getRun("bob-old")).not.toBeNull();
  });
});
