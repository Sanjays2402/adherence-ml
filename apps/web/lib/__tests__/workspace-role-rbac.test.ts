/**
 * RBAC role-change safety test for changeMemberRoleByOwner.
 *
 * Proves:
 *   - an editor cannot change roles (returns 'forbidden')
 *   - a viewer cannot change roles (returns 'forbidden')
 *   - an owner from workspace A cannot mutate workspace B members
 *     (returns 'forbidden' because they are not a member of B at all)
 *   - the last owner of a workspace cannot be demoted ('last_owner')
 *   - a valid owner-driven promotion / demotion mutates the store
 *
 * Run with: pnpm tsx lib/__tests__/workspace-role-rbac.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "wsrole-"));
process.env.ADHERENCE_DATA_DIR = tmp;

function fail(msg: string): never {
  console.error("FAIL:", msg);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
function ok(cond: unknown, msg: string) {
  if (!cond) fail(msg);
}

async function main() {
  const {
    createWorkspace,
    provisionMember,
    findMember,
    changeMemberRoleByOwner,
  } = await import("../workspaces-store");
  const users = await import("../users-store");

  const aliceOwner = await users.getOrCreateUserByEmail("alice@acme.test");
  const bobOwner = await users.getOrCreateUserByEmail("bob@beta.test");
  const wsA = await createWorkspace(aliceOwner.id, "alice@acme.test", "Acme");
  const wsB = await createWorkspace(bobOwner.id, "bob@beta.test", "Beta");

  // Seed wsA with editor + viewer.
  const editorProv = await provisionMember(wsA.id, "eve@acme.test", "editor");
  const viewerProv = await provisionMember(wsA.id, "val@acme.test", "viewer");
  const editorId = editorProv.user_id;
  const viewerId = viewerProv.user_id;

  // 1. Editor cannot change roles.
  const r1 = await changeMemberRoleByOwner(wsA.id, editorId, viewerId, "editor");
  ok(r1 === "forbidden", `editor must not change roles, got ${JSON.stringify(r1)}`);

  // 2. Viewer cannot change roles.
  const r2 = await changeMemberRoleByOwner(wsA.id, viewerId, editorId, "viewer");
  ok(r2 === "forbidden", `viewer must not change roles, got ${JSON.stringify(r2)}`);

  // 3. Bob (owner of wsB) cannot mutate wsA members at all.
  const r3 = await changeMemberRoleByOwner(wsA.id, bobOwner.id, editorId, "viewer");
  ok(r3 === "forbidden", `cross-tenant owner must be forbidden, got ${JSON.stringify(r3)}`);

  // Confirm none of the above wrote: editor + viewer roles unchanged.
  const eStill = await findMember(wsA.id, editorId);
  const vStill = await findMember(wsA.id, viewerId);
  ok(eStill?.role === "editor", `editor role should still be editor, got ${eStill?.role}`);
  ok(vStill?.role === "viewer", `viewer role should still be viewer, got ${vStill?.role}`);

  // 4. Alice (sole owner) cannot demote herself.
  const r4 = await changeMemberRoleByOwner(wsA.id, aliceOwner.id, aliceOwner.id, "editor");
  ok(r4 === "last_owner", `last-owner demotion must be blocked, got ${JSON.stringify(r4)}`);

  // 5. Alice can promote editor to owner (valid path).
  const r5 = await changeMemberRoleByOwner(wsA.id, aliceOwner.id, editorId, "owner");
  ok(typeof r5 !== "string", `valid promotion should succeed, got ${JSON.stringify(r5)}`);
  const ePromoted = await findMember(wsA.id, editorId);
  ok(ePromoted?.role === "owner", `editor should now be owner, got ${ePromoted?.role}`);

  // 6. With two owners now, Alice can demote herself.
  const r6 = await changeMemberRoleByOwner(wsA.id, aliceOwner.id, aliceOwner.id, "viewer");
  ok(typeof r6 !== "string", `self-demote with another owner should succeed, got ${JSON.stringify(r6)}`);
  const aliceNow = await findMember(wsA.id, aliceOwner.id);
  ok(aliceNow?.role === "viewer", `alice should now be viewer, got ${aliceNow?.role}`);

  // 7. Invalid role rejected.
  const r7 = await changeMemberRoleByOwner(wsA.id, editorId, viewerId, "superadmin" as never);
  ok(r7 === "invalid_role", `invalid role must be rejected, got ${JSON.stringify(r7)}`);

  // 8. Unknown target user (not a member) returns not_found.
  const r8 = await changeMemberRoleByOwner(wsA.id, editorId, "no-such-user", "viewer");
  ok(r8 === "not_found", `unknown member must return not_found, got ${JSON.stringify(r8)}`);

  console.log("workspace-role-rbac: ok");
  rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
