/**
 * RBAC safety tests for owner-driven role changes via changeMemberRoleByOwner.
 *
 * Proves that:
 *   - editors/viewers cannot mutate roles
 *   - owners of one workspace cannot mutate members of another (no cross-tenant write)
 *   - the last owner of a workspace cannot be demoted
 *   - invalid role strings and unknown targets are rejected
 *   - a valid owner-driven promote/demote round-trip succeeds
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "wsrole-vitest-"));

beforeAll(() => {
  process.env.ADHERENCE_DATA_DIR = tmp;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("workspace role RBAC", () => {
  it("enforces owner-only role changes with tenant isolation and last-owner safety", async () => {
    const {
      createWorkspace,
      provisionMember,
      findMember,
      changeMemberRoleByOwner,
    } = await import("../lib/workspaces-store");
    const users = await import("../lib/users-store");

    const alice = await users.getOrCreateUserByEmail("alice-rbac@acme.test");
    const bob = await users.getOrCreateUserByEmail("bob-rbac@beta.test");
    const wsA = await createWorkspace(alice.id, "alice-rbac@acme.test", "Acme RBAC");
    await createWorkspace(bob.id, "bob-rbac@beta.test", "Beta RBAC");

    const eve = await provisionMember(wsA.id, "eve-rbac@acme.test", "editor");
    const val = await provisionMember(wsA.id, "val-rbac@acme.test", "viewer");

    // editor cannot change roles
    expect(await changeMemberRoleByOwner(wsA.id, eve.user_id, val.user_id, "editor")).toBe("forbidden");
    // viewer cannot change roles
    expect(await changeMemberRoleByOwner(wsA.id, val.user_id, eve.user_id, "viewer")).toBe("forbidden");
    // cross-tenant owner cannot mutate wsA
    expect(await changeMemberRoleByOwner(wsA.id, bob.id, eve.user_id, "viewer")).toBe("forbidden");

    // none of the above wrote
    expect((await findMember(wsA.id, eve.user_id))?.role).toBe("editor");
    expect((await findMember(wsA.id, val.user_id))?.role).toBe("viewer");

    // last owner cannot be demoted
    expect(await changeMemberRoleByOwner(wsA.id, alice.id, alice.id, "editor")).toBe("last_owner");

    // valid promotion
    const promoted = await changeMemberRoleByOwner(wsA.id, alice.id, eve.user_id, "owner");
    expect(typeof promoted).not.toBe("string");
    expect((await findMember(wsA.id, eve.user_id))?.role).toBe("owner");

    // with two owners, alice can now demote herself
    const demoted = await changeMemberRoleByOwner(wsA.id, alice.id, alice.id, "viewer");
    expect(typeof demoted).not.toBe("string");
    expect((await findMember(wsA.id, alice.id))?.role).toBe("viewer");

    // invalid role rejected
    expect(
      await changeMemberRoleByOwner(wsA.id, eve.user_id, val.user_id, "superadmin" as never),
    ).toBe("invalid_role");

    // unknown target rejected (eve is now owner of wsA, so she has permission to attempt)
    expect(
      await changeMemberRoleByOwner(wsA.id, eve.user_id, "no-such-user", "viewer"),
    ).toBe("not_found");
  });
});
