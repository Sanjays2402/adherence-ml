import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-residency-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.ADHERENCE_DEPLOY_REGION = "us-east";

const users = await import("../lib/users-store");
const ws = await import("../lib/workspaces-store");
const residency = await import("../lib/residency");

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
  delete process.env.ADHERENCE_DEPLOY_REGION;
});

async function makeUser(email: string) {
  const { token } = await users.issueMagicToken(email);
  const u = await users.consumeMagicToken(token);
  if (!u) throw new Error("user not minted");
  await ws.listForUser(u.id, u.email);
  return u;
}

describe("workspace data residency", () => {
  it("defaults to unspecified", () => {
    const p = ws.publicPolicy(null);
    expect(p.data_residency).toBe("unspecified");
  });

  it("persists a region set by the workspace owner and rejects non-owners", async () => {
    const u = await makeUser("owner@residency.test");
    const guest = await makeUser("guest@residency.test");
    const mine = await ws.listForUser(u.id, u.email);
    const myWs = mine[0]!;

    const inv = await ws.createInvite(myWs.id, u.id, guest.email, "viewer");
    await ws.acceptInvite(inv.token, guest.id, guest.email);

    const updated = await ws.setWorkspacePolicy(myWs.id, u.id, {
      session_max_age_minutes: null,
      require_mfa: false,
      data_residency: "eu-frankfurt",
    });
    expect(updated.data_residency).toBe("eu-frankfurt");

    const got = await ws.getWorkspacePolicy(myWs.id);
    expect(got?.data_residency).toBe("eu-frankfurt");

    await expect(
      ws.setWorkspacePolicy(myWs.id, guest.id, {
        session_max_age_minutes: null,
        require_mfa: false,
        data_residency: "us",
      }),
    ).rejects.toThrow(/owner only/);
  });

  it("rejects unknown region values at the type guard", () => {
    expect(ws.isDataResidencyRegion("eu")).toBe(true);
    expect(ws.isDataResidencyRegion("eu-frankfurt")).toBe(true);
    expect(ws.isDataResidencyRegion("antarctica")).toBe(false);
    expect(ws.isDataResidencyRegion(42)).toBe(false);
  });

  it("residencyMatch treats broader region as compatible with subregion", () => {
    expect(residency.residencyMatch("eu", "eu-frankfurt")).toBe("match");
    expect(residency.residencyMatch("eu-frankfurt", "eu")).toBe("match");
    expect(residency.residencyMatch("eu", "us-east")).toBe("mismatch");
    expect(residency.residencyMatch("eu", "unspecified")).toBe("unspecified");
    expect(residency.residencyMatch("unspecified", "us-east")).toBe("unspecified");
    expect(residency.residencyMatch("us-east", "us-east")).toBe("match");
  });

  it("reads deployment region from ADHERENCE_DEPLOY_REGION", () => {
    expect(residency.deploymentRegion()).toBe("us-east");
  });
});
