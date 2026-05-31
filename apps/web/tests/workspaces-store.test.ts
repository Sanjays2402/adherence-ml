import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-store-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("workspaces-store", () => {
  it("auto-creates a personal workspace for a new user", async () => {
    const store = await import("../lib/workspaces-store");
    const list = await store.listForUser("u_alice", "alice@example.com");
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe("owner");
    expect(list[0].name.toLowerCase()).toContain("alice");
  });

  it("invites by email, previews, accepts only for matching email, and is idempotent on members", async () => {
    const store = await import("../lib/workspaces-store");
    const [ws] = await store.listForUser("u_alice", "alice@example.com");

    const { token, invite } = await store.createInvite(
      ws.id,
      "u_alice",
      "Bob@Example.com", // mixed case to confirm normalization
      "editor",
    );
    expect(invite.email).toBe("bob@example.com");
    expect(invite.role).toBe("editor");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);

    const preview = await store.previewInvite(token);
    expect(preview).not.toBeNull();
    expect(preview!.workspace.id).toBe(ws.id);

    // Wrong email is rejected.
    const wrong = await store.acceptInvite(token, "u_charlie", "charlie@example.com");
    expect(wrong).toBeNull();

    // Right email accepts.
    const ok = await store.acceptInvite(token, "u_bob", "bob@example.com");
    expect(ok).not.toBeNull();
    expect(ok!.role).toBe("editor");

    // Re-accept (same user) is a no-op but still returns the membership.
    const again = await store.acceptInvite(token, "u_bob", "bob@example.com");
    // token is consumed (accepted_at set) so it now returns null.
    expect(again).toBeNull();

    const detail = await store.getWorkspaceForUser(ws.id, "u_bob");
    expect(detail).not.toBeNull();
    expect(detail!.members).toHaveLength(2);
    expect(detail!.members.find((m) => m.user_id === "u_bob")?.role).toBe("editor");
  });

  it("revokes invites and rejects duplicate pending invites", async () => {
    const store = await import("../lib/workspaces-store");
    const [ws] = await store.listForUser("u_alice", "alice@example.com");

    const a = await store.createInvite(ws.id, "u_alice", "dave@example.com", "viewer");
    await expect(
      store.createInvite(ws.id, "u_alice", "dave@example.com", "viewer"),
    ).rejects.toThrow(/pending/);

    const revoked = await store.revokeInvite(ws.id, a.invite.id);
    expect(revoked).toBe(true);

    // After revoking, a fresh invite is allowed.
    const b = await store.createInvite(ws.id, "u_alice", "dave@example.com", "viewer");
    expect(b.invite.id).not.toEqual(a.invite.id);
  });

  it("removeMember enforces owner-only and refuses to remove the last owner", async () => {
    const store = await import("../lib/workspaces-store");
    const [ws] = await store.listForUser("u_alice", "alice@example.com");

    // Add bob as editor
    const inv = await store.createInvite(ws.id, "u_alice", "bob@example.com", "editor");
    await store.acceptInvite(inv.token, "u_bob", "bob@example.com");

    // Editor cannot remove a member.
    const denied = await store.removeMember(ws.id, "u_bob", "u_alice");
    expect(denied).toBe(false);

    // Owner cannot remove themselves while they're the only owner.
    const selfRemove = await store.removeMember(ws.id, "u_alice", "u_alice");
    expect(selfRemove).toBe(false);

    // Owner can remove an editor.
    const removed = await store.removeMember(ws.id, "u_alice", "u_bob");
    expect(removed).toBe(true);

    const after = await store.getWorkspaceForUser(ws.id, "u_alice");
    expect(after!.members).toHaveLength(1);
  });

  it("updateMemberRole promotes/demotes and refuses to demote the last owner", async () => {
    const store = await import("../lib/workspaces-store");
    const [ws] = await store.listForUser("u_alice", "alice@example.com");

    // Add bob as editor via invite flow.
    const { token } = await store.createInvite(ws.id, "u_alice", "bob@example.com", "editor");
    await store.acceptInvite(token, "u_bob", "bob@example.com");

    // Non-owner cannot change roles.
    const denied = await store.updateMemberRole(ws.id, "u_bob", "u_alice", "viewer");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("forbidden");

    // Owner promotes bob to owner.
    const promoted = await store.updateMemberRole(ws.id, "u_alice", "u_bob", "owner");
    expect(promoted.ok).toBe(true);
    if (promoted.ok) expect(promoted.member.role).toBe("owner");

    // Owner demotes themselves now that another owner exists.
    const selfDemoted = await store.updateMemberRole(ws.id, "u_alice", "u_alice", "editor");
    expect(selfDemoted.ok).toBe(true);

    // Bob (now last owner) cannot demote themselves.
    const lastOwner = await store.updateMemberRole(ws.id, "u_bob", "u_bob", "viewer");
    expect(lastOwner.ok).toBe(false);
    if (!lastOwner.ok) expect(lastOwner.reason).toBe("last_owner");

    // Invalid role rejected.
    const bad = await store.updateMemberRole(
      ws.id,
      "u_bob",
      "u_alice",
      "admin" as unknown as "owner",
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_role");
  });

  it("renameWorkspace requires owner and trims input", async () => {
    const store = await import("../lib/workspaces-store");
    const [ws] = await store.listForUser("u_alice", "alice@example.com");

    const { token } = await store.createInvite(ws.id, "u_alice", "bob@example.com", "editor");
    await store.acceptInvite(token, "u_bob", "bob@example.com");

    const denied = await store.renameWorkspace(ws.id, "u_bob", "hijacked");
    expect(denied).toBeNull();

    const renamed = await store.renameWorkspace(ws.id, "u_alice", "  Acme Lab  ");
    expect(renamed?.name).toBe("Acme Lab");

    const empty = await store.renameWorkspace(ws.id, "u_alice", "   ");
    expect(empty).toBeNull();
  });

  it("deleteWorkspace cascades members and invites and is owner-only", async () => {
    const store = await import("../lib/workspaces-store");
    const [ws] = await store.listForUser("u_alice", "alice@example.com");

    const { token } = await store.createInvite(ws.id, "u_alice", "bob@example.com", "editor");
    await store.acceptInvite(token, "u_bob", "bob@example.com");
    // Leave one pending invite around to verify cascade.
    await store.createInvite(ws.id, "u_alice", "carol@example.com", "viewer");

    const denied = await store.deleteWorkspace(ws.id, "u_bob");
    expect(denied).toBe(false);

    const ok = await store.deleteWorkspace(ws.id, "u_alice");
    expect(ok).toBe(true);

    expect(await store.getWorkspaceForUser(ws.id, "u_alice")).toBeNull();
    expect(await store.listInvites(ws.id)).toHaveLength(0);
  });
});
