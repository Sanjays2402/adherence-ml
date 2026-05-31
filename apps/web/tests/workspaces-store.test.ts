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
});
