/**
 * workspace-delete: owner-initiated tenant offboarding.
 *
 * Procurement check: confirm the deletion path enforces
 *   1. owner-only (other roles get "forbidden")
 *   2. typed confirmation phrase (bad phrase -> "bad_confirm", no mutation)
 *   3. cross-tenant isolation (deleting workspace A does NOT touch B)
 *   4. cascade into SCIM tokens scoped to the deleted workspace
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-delete-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("workspace-delete: owner-initiated tenant offboarding", () => {
  it("rejects non-owners and never mutates the store", async () => {
    const ws = await import("../lib/workspaces-store");
    const del = await import("../lib/workspace-delete");

    const [alice] = await ws.listForUser("u_alice", "alice@acme.com");
    const bob = await ws.provisionMember(alice.id, "bob@acme.com", "editor");

    const previewBob = await del.previewWorkspaceDeletion(alice.id, bob.user_id);
    expect(previewBob).toBe("forbidden");

    const execBob = await del.executeWorkspaceDeletion(
      alice.id,
      bob.user_id,
      del.workspaceDeleteConfirmPhrase(alice.name),
    );
    expect(execBob).toBe("forbidden");

    const stillThere = await ws.getWorkspaceForUser(alice.id, bob.user_id);
    expect(stillThere).not.toBeNull();
  });

  it("requires the exact typed confirmation phrase", async () => {
    const ws = await import("../lib/workspaces-store");
    const del = await import("../lib/workspace-delete");

    const [alice] = await ws.listForUser("u_alice", "alice@acme.com");

    const bad = await del.executeWorkspaceDeletion(
      alice.id,
      "u_alice",
      "DELETE WORKSPACE wrong-name",
    );
    expect(bad).toBe("bad_confirm");

    const ctx = await ws.getWorkspaceForUser(alice.id, "u_alice");
    expect(ctx).not.toBeNull();
  });

  it("deletes only the targeted workspace and leaves other tenants untouched", async () => {
    const ws = await import("../lib/workspaces-store");
    const del = await import("../lib/workspace-delete");
    const scim = await import("../lib/scim-store");

    const [alice] = await ws.listForUser("u_alice", "alice@acme.com");
    const [mallory] = await ws.listForUser("u_mallory", "mallory@evil.example");
    expect(alice.id).not.toBe(mallory.id);

    await ws.provisionMember(alice.id, "bob@acme.com", "editor");

    const invA = await ws.createInvite(alice.id, "u_alice", "carol@acme.com", "viewer");
    const invM = await ws.createInvite(mallory.id, "u_mallory", "dave@evil.example", "viewer");

    const tokA = await scim.createToken(alice.id, "u_alice", "tokA");
    const tokM = await scim.createToken(mallory.id, "u_mallory", "tokM");
    expect(tokA.token.id).not.toBe(tokM.token.id);

    const preview = await del.previewWorkspaceDeletion(alice.id, "u_alice");
    if (!preview || typeof preview === "string") throw new Error("preview failed");
    expect(preview.workspace_id).toBe(alice.id);
    expect(preview.members.length).toBe(2); // alice + bob
    expect(preview.invites_total).toBeGreaterThanOrEqual(1);
    expect(preview.confirm_phrase).toBe(`DELETE WORKSPACE ${alice.name}`);
    void invA;

    const report = await del.executeWorkspaceDeletion(
      alice.id,
      "u_alice",
      preview.confirm_phrase,
    );
    if (typeof report === "string") throw new Error(`delete failed: ${report}`);
    expect(report.workspace_id).toBe(alice.id);
    expect(report.members_removed).toBe(2);
    expect(report.invites_removed).toBeGreaterThanOrEqual(1);
    expect(report.scim_tokens_removed).toBe(1);

    // Workspace A is gone.
    const goneForAlice = await ws.getWorkspaceForUser(alice.id, "u_alice");
    expect(goneForAlice).toBeNull();

    // Workspace M survives intact for Mallory.
    const stillForMallory = await ws.getWorkspaceForUser(mallory.id, "u_mallory");
    expect(stillForMallory).not.toBeNull();
    const invitesM = await ws.listInvites(mallory.id);
    expect(invitesM.map((i) => i.id)).toContain(invM.invite.id);
    const tokensM = await scim.listForWorkspace(mallory.id);
    expect(tokensM.map((t) => t.id)).toContain(tokM.token.id);

    // And no SCIM token leaks from A into the global store.
    const tokensA = await scim.listForWorkspace(alice.id);
    expect(tokensA.length).toBe(0);
  });

  it("returns not_found for a workspace the caller is not a member of", async () => {
    const ws = await import("../lib/workspaces-store");
    const del = await import("../lib/workspace-delete");

    const [alice] = await ws.listForUser("u_alice", "alice@acme.com");

    const out = await del.previewWorkspaceDeletion(alice.id, "u_mallory_stranger");
    expect(out).toBeNull();

    const out2 = await del.executeWorkspaceDeletion(
      alice.id,
      "u_mallory_stranger",
      `DELETE WORKSPACE ${alice.name}`,
    );
    expect(out2).toBe("not_found");
  });
});
