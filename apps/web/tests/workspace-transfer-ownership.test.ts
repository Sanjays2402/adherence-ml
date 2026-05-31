import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "wsxfer-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("workspace ownership transfer", () => {
  it("hands ownership to an existing member and demotes the prior owner", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    await ws.provisionMember(wsA.id, "bob@example.com", "editor");
    const members = await ws.listMembers(wsA.id);
    const bob = members.find((m) => m.email === "bob@example.com")!;

    const result = await ws.transferOwnership(wsA.id, "u_alice", bob.user_id);
    expect(typeof result).toBe("object");
    if (typeof result === "string") throw new Error("expected success");
    expect(result.target.role).toBe("owner");
    expect(result.acting.role).toBe("editor");

    // Re-read: roles persisted.
    const after = await ws.listMembers(wsA.id);
    expect(after.find((m) => m.user_id === bob.user_id)?.role).toBe("owner");
    expect(after.find((m) => m.user_id === "u_alice")?.role).toBe("editor");
  });

  it("refuses transfer-to-self", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const r = await ws.transferOwnership(wsA.id, "u_alice", "u_alice");
    expect(r).toBe("self");
  });

  it("refuses when caller is not an owner (cross-role denial)", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const bob = await ws.provisionMember(wsA.id, "bob@example.com", "editor");
    const carol = await ws.provisionMember(wsA.id, "carol@example.com", "editor");
    // bob (editor) tries to hand the workspace to carol
    const r = await ws.transferOwnership(wsA.id, bob.user_id, carol.user_id);
    expect(r).toBe("forbidden");
    // Alice is still the only owner.
    const after = await ws.listMembers(wsA.id);
    expect(after.filter((m) => m.role === "owner")).toHaveLength(1);
    expect(after.find((m) => m.role === "owner")?.user_id).toBe("u_alice");
  });

  it("refuses when target is not a member (cross-tenant denial)", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const [wsB] = await ws.listForUser("u_dave", "dave@elsewhere.com");
    // Alice owns wsA. Dave belongs to wsB only. Alice cannot hand wsA to Dave.
    const r = await ws.transferOwnership(wsA.id, "u_alice", "u_dave");
    expect(r).toBe("not_found");
    // wsB is untouched.
    const bMembers = await ws.listMembers(wsB.id);
    expect(bMembers.find((m) => m.user_id === "u_dave")?.role).toBe("owner");
  });

  it("rejects an invalid demoteTo role", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const bob = await ws.provisionMember(wsA.id, "bob@example.com", "editor");
    const r = await ws.transferOwnership(
      wsA.id,
      "u_alice",
      bob.user_id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "owner" as any,
    );
    expect(r).toBe("invalid_role");
  });
});
