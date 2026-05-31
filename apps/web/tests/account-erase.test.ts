/**
 * GDPR / CCPA right-to-erasure smoke test.
 *
 * Proves:
 *   - Sole owner of a multi-member shared workspace is BLOCKED.
 *   - After ownership is shared, alice can erase: her personal workspace is
 *     deleted, the shared workspace survives because bob is co-owner.
 *   - Alice's notes are tombstoned; bob's notes are untouched (cross-tenant
 *     isolation under the same workspace).
 *   - Alice's user record and unconsumed magic-link tokens are gone.
 *   - Second preview returns null (user no longer exists).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-erase-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const users = await import("../lib/users-store");
const ws = await import("../lib/workspaces-store");
const notes = await import("../lib/notes-store");
const erase = await import("../lib/account-erase");

beforeAll(async () => {
  await users._resetForTests();
  await ws._resetForTests();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("account erasure (GDPR / CCPA)", () => {
  it("blocks sole owner, succeeds after co-owner transfer, preserves cross-tenant data", async () => {
    const alice = await users.getOrCreateUserByEmail("alice@example.com");
    const bob = await users.getOrCreateUserByEmail("bob@example.com");

    // Personal workspaces auto-created.
    const aliceWorkspaces = await ws.listForUser(alice.id, alice.email);
    await ws.listForUser(bob.id, bob.email);
    expect(aliceWorkspaces.length).toBe(1);
    const alicePersonal = aliceWorkspaces[0]!;

    // Shared workspace where alice is sole owner; invite bob as editor.
    const shared = await ws.createWorkspace(alice.id, alice.email, "Acme");
    const { token } = await ws.createInvite(
      shared.id,
      alice.id,
      "bob@example.com",
      "editor",
    );
    const accepted = await ws.acceptInvite(token, bob.id, bob.email);
    expect(accepted).not.toBeNull();

    // Issue a magic-link token to alice's email so we can prove it is purged.
    await users.issueMagicToken(alice.email);

    // Notes: alice authors one in run_1, bob authors one in run_2 (same data dir).
    await notes.createNote({
      run_id: "run_1",
      body: "alice secret",
      user_id: alice.id,
      author_email: alice.email,
    });
    await notes.createNote({
      run_id: "run_2",
      body: "bob secret",
      user_id: bob.id,
      author_email: bob.email,
    });

    // 1. Preview: alice should be blocked.
    const preview = await erase.previewAccountErasure(alice.id);
    expect(preview).not.toBeNull();
    expect(preview!.can_erase).toBe(false);
    expect(preview!.blockers.some((b) => b.workspace_id === shared.id)).toBe(
      true,
    );

    // 2. Calling eraseAccount on blocked user must throw the typed error.
    await expect(erase.eraseAccount(alice)).rejects.toBeInstanceOf(
      erase.AccountErasureBlocked,
    );
    expect(await users.getUserById(alice.id)).not.toBeNull();
    expect((await notes.listNotesForRun("run_1")).length).toBe(1);

    // 3. Promote bob to co-owner of the shared workspace.
    const storePath = path.join(tmp, "workspaces.json");
    const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      members: Array<{
        workspace_id: string;
        user_id: string;
        role: string;
      }>;
    };
    for (const m of raw.members) {
      if (m.workspace_id === shared.id && m.user_id === bob.id) {
        m.role = "owner";
      }
    }
    await fs.writeFile(storePath, JSON.stringify(raw, null, 2), "utf8");

    // 4. Re-preview: alice is now eligible.
    const preview2 = await erase.previewAccountErasure(alice.id);
    expect(preview2!.can_erase).toBe(true);
    expect(
      preview2!.memberships.find((m) => m.workspace_id === alicePersonal.id)
        ?.action,
    ).toBe("delete_workspace");
    expect(
      preview2!.memberships.find((m) => m.workspace_id === shared.id)?.action,
    ).toBe("leave");

    // 5. Execute.
    const result = await erase.eraseAccount(alice);
    expect(result.user_id).toBe(alice.id);
    expect(result.workspaces.workspaces_deleted).toContain(alicePersonal.id);
    expect(result.workspaces.workspaces_deleted).not.toContain(shared.id);
    expect(result.notes_tombstoned).toBe(1);

    // 6. Post-conditions.
    expect(await users.getUserById(alice.id)).toBeNull();
    expect(await users.getUserById(bob.id)).not.toBeNull();
    expect((await notes.listNotesForRun("run_1")).length).toBe(0);
    const run2 = await notes.listNotesForRun("run_2");
    expect(run2.length).toBe(1);
    expect(run2[0]!.author_email).toBe(bob.email);

    // Shared workspace still exists and bob can still see it without alice.
    const bobView = await ws.getWorkspaceForUser(shared.id, bob.id);
    expect(bobView).not.toBeNull();
    expect(bobView!.members.every((m) => m.user_id !== alice.id)).toBe(true);

    // Magic-link tokens for alice are gone from users.json.
    const usersRaw = JSON.parse(
      await fs.readFile(path.join(tmp, "users.json"), "utf8"),
    ) as { tokens: Array<{ email: string }> };
    expect(
      usersRaw.tokens.every((t) => t.email !== alice.email),
    ).toBe(true);

    // Second preview returns null (user gone).
    expect(await erase.previewAccountErasure(alice.id)).toBeNull();
  });
});
