import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "scim-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("SCIM provisioning + cross-tenant isolation", () => {
  it("provisions a member into the correct workspace and is idempotent", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");

    const r1 = await ws.provisionMember(wsA.id, "Bob@Example.com", "editor");
    expect(r1.email).toBe("bob@example.com");
    expect(r1.joined).toBe(true);

    const r2 = await ws.provisionMember(wsA.id, "bob@example.com", "editor");
    expect(r2.joined).toBe(false);
    expect(r2.user_id).toBe(r1.user_id);

    const members = await ws.listMembers(wsA.id);
    expect(members.filter((m) => m.email === "bob@example.com")).toHaveLength(1);
  });

  it("refuses to demote or remove the last owner via SCIM", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const owner = (await ws.listMembers(wsA.id)).find((m) => m.role === "owner")!;
    await expect(
      ws.setMemberRole(wsA.id, owner.user_id, "viewer"),
    ).rejects.toThrow(/last owner/);
    await expect(
      ws.deprovisionMember(wsA.id, owner.user_id),
    ).rejects.toThrow(/last owner/);
  });

  it("scim bearer tokens are workspace-scoped: a token for A cannot touch B", async () => {
    const ws = await import("../lib/workspaces-store");
    const scim = await import("../lib/scim-store");

    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const [wsB] = await ws.listForUser("u_carol", "carol@example.com");
    expect(wsA.id).not.toBe(wsB.id);

    // Provision a member into B so there is a cross-tenant target to attack.
    await ws.provisionMember(wsB.id, "victim@example.com", "viewer");
    const victim = (await ws.listMembers(wsB.id)).find(
      (m) => m.email === "victim@example.com",
    )!;
    expect(victim).toBeDefined();

    // Mint a SCIM token scoped to A only.
    const { plaintext } = await scim.createToken(wsA.id, "u_alice", "okta");
    const auth = await scim.verifyToken(plaintext, "127.0.0.1");
    expect(auth).not.toBeNull();
    expect(auth!.workspaceId).toBe(wsA.id);

    // A token for A must not see, mutate, or delete B's member.
    expect(await ws.findMember(auth!.workspaceId, victim.user_id)).toBeNull();
    expect(await ws.setMemberRole(auth!.workspaceId, victim.user_id, "owner")).toBeNull();
    expect(await ws.deprovisionMember(auth!.workspaceId, victim.user_id)).toBe(false);

    // B's member must still exist, untouched.
    const stillThere = await ws.findMember(wsB.id, victim.user_id);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.role).toBe("viewer");
  });

  it("revoked tokens stop authenticating immediately", async () => {
    const ws = await import("../lib/workspaces-store");
    const scim = await import("../lib/scim-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const { plaintext, token } = await scim.createToken(wsA.id, "u_alice", "okta");
    expect(await scim.verifyToken(plaintext, null)).not.toBeNull();
    expect(await scim.revokeToken(wsA.id, token.id)).toBe(true);
    expect(await scim.verifyToken(plaintext, null)).toBeNull();
    // Double-revoke is a no-op.
    expect(await scim.revokeToken(wsA.id, token.id)).toBe(false);
  });

  it("tracks last-used metadata on each verification", async () => {
    const ws = await import("../lib/workspaces-store");
    const scim = await import("../lib/scim-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const { plaintext, token } = await scim.createToken(wsA.id, "u_alice", "okta");
    await scim.verifyToken(plaintext, "10.0.0.1");
    await scim.verifyToken(plaintext, "10.0.0.2");
    const list = await scim.listForWorkspace(wsA.id);
    const t = list.find((x) => x.id === token.id)!;
    expect(t.use_count).toBe(2);
    expect(t.last_used_ip).toBe("10.0.0.2");
    expect(t.last_used_at).toBeGreaterThan(0);
  });
});
