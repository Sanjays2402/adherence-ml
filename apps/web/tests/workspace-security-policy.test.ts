import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-policy-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";

const users = await import("../lib/users-store");
const ws = await import("../lib/workspaces-store");
const session = await import("../lib/session");

beforeAll(async () => {
  for (const f of ["users.json", "workspaces.json"]) {
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
  // Trigger personal workspace creation.
  await ws.listForUser(u.id, u.email);
  return u;
}

describe("workspace security policy", () => {
  it("caps minted session lifetime to the workspace policy", async () => {
    const u = await makeUser("owner@policy.test");
    const mine = await ws.listForUser(u.id, u.email);
    const myWs = mine[0]!;

    // No policy yet: default 30-day cookie.
    const before = await session.buildSession(u);
    const beforeMs = before.expires.getTime() - Date.now();
    expect(beforeMs).toBeGreaterThan(20 * 24 * 60 * 60 * 1000);

    // Set a 60-minute cap as owner.
    await ws.setWorkspacePolicy(myWs.id, u.id, {
      session_max_age_minutes: 60,
      require_mfa: false,
    });

    const after = await session.buildSession(u);
    const afterMs = after.expires.getTime() - Date.now();
    expect(afterMs).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
    expect(afterMs).toBeGreaterThan(50 * 60 * 1000);
  });

  it("refuses non-owners from changing the policy", async () => {
    const u = await makeUser("owner2@policy.test");
    const guest = await makeUser("guest@policy.test");
    const mine = await ws.listForUser(u.id, u.email);
    const myWs = mine[0]!;

    // Add guest as viewer via direct invite plumbing.
    const inv = await ws.createInvite(myWs.id, u.id, guest.email, "viewer");
    await ws.acceptInvite(inv.token, guest.id, guest.email);

    await expect(
      ws.setWorkspacePolicy(myWs.id, guest.id, {
        session_max_age_minutes: 30,
        require_mfa: true,
      }),
    ).rejects.toThrow(/owner only/);
  });

  it("require_mfa flags users that lack TOTP via mfaRequiredButMissing", async () => {
    const u = await makeUser("nomfa@policy.test");
    const mine = await ws.listForUser(u.id, u.email);
    const myWs = mine[0]!;
    // Baseline: no policy, MFA not required.
    expect(await session.mfaRequiredButMissing(u)).toBe(false);

    await ws.setWorkspacePolicy(myWs.id, u.id, {
      session_max_age_minutes: null,
      require_mfa: true,
    });

    expect(await session.mfaRequiredButMissing(u)).toBe(true);
  });

  it("rejects validation outside the documented range", async () => {
    const u = await makeUser("validate@policy.test");
    const mine = await ws.listForUser(u.id, u.email);
    const myWs = mine[0]!;
    await expect(
      ws.setWorkspacePolicy(myWs.id, u.id, {
        session_max_age_minutes: 1,
        require_mfa: false,
      }),
    ).rejects.toThrow(/session_max_age_minutes/);
  });

  it("tightest workspace policy wins across multiple workspaces", async () => {
    const u = await makeUser("multi@policy.test");
    const mine = await ws.listForUser(u.id, u.email);
    const wsA = mine[0]!;
    const wsB = await ws.createWorkspace(u.id, u.email, "Project B");
    await ws.setWorkspacePolicy(wsA.id, u.id, {
      session_max_age_minutes: 240,
      require_mfa: false,
    });
    await ws.setWorkspacePolicy(wsB.id, u.id, {
      session_max_age_minutes: 30,
      require_mfa: true,
    });

    const eff = await ws.effectivePolicyForUser(u.id);
    expect(eff.session_max_age_minutes).toBe(30);
    expect(eff.require_mfa).toBe(true);
  });
});
