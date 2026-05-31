/**
 * SCIM cross-tenant isolation + provisioning smoke test.
 *
 * Proves:
 *   - tokens minted for workspace A are recognised
 *   - a workspace-A token cannot read, modify, or delete a member of
 *     workspace B via the workspaces-store SCIM helpers
 *   - provisionMember creates a new user + member row when the email is new
 *   - re-provisioning the same email updates the role instead of duplicating
 *   - cannot demote / deprovision the last owner of a workspace
 *
 * Run with: pnpm tsx lib/__tests__/scim-store.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "scim-"));
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
  const { createWorkspace } = await import("../workspaces-store");
  const {
    provisionMember,
    findMember,
    listMembers,
    setMemberRole,
    deprovisionMember,
  } = await import("../workspaces-store");
  const scim = await import("../scim-store");
  const users = await import("../users-store");

  // Two ownerless workspaces require seed users. Simulate the magic-link
  // flow by creating the owner via getOrCreateUserByEmail, then createWorkspace.
  const aliceOwner = await users.getOrCreateUserByEmail("alice@acme.test");
  const bobOwner = await users.getOrCreateUserByEmail("bob@beta.test");

  const wsA = await createWorkspace(aliceOwner.id, "alice@acme.test", "Acme");
  const wsB = await createWorkspace(bobOwner.id, "bob@beta.test", "Beta");

  // Mint a SCIM token for each workspace.
  const aTok = await scim.createToken(wsA.id, aliceOwner.id, "Okta prod");
  const bTok = await scim.createToken(wsB.id, bobOwner.id, "Azure AD");

  ok(aTok.plaintext.startsWith("scim_v2_"), "plaintext token has expected prefix");
  ok(aTok.plaintext !== bTok.plaintext, "tokens are unique");

  // Both tokens validate, each pointing at its own workspace only.
  const aAuth = await scim.verifyToken(aTok.plaintext, "10.0.0.1");
  const bAuth = await scim.verifyToken(bTok.plaintext, "10.0.0.2");
  ok(aAuth?.workspaceId === wsA.id, "A-token resolves to wsA");
  ok(bAuth?.workspaceId === wsB.id, "B-token resolves to wsB");

  // Provision a member in each workspace via SCIM helpers.
  const aMember = await provisionMember(wsA.id, "carla@acme.test", "editor");
  const bMember = await provisionMember(wsB.id, "dave@beta.test", "viewer");
  ok(aMember.joined, "carla joined wsA");
  ok(bMember.joined, "dave joined wsB");

  // CROSS-TENANT READ: token A workspace cannot find dave (he lives in wsB).
  const crossRead = await findMember(aAuth!.workspaceId, bMember.user_id);
  ok(crossRead === null, "cross-tenant findMember must return null");

  // CROSS-TENANT WRITE: setMemberRole scoped to wsA cannot change dave's role.
  const crossWrite = await setMemberRole(aAuth!.workspaceId, bMember.user_id, "viewer");
  ok(crossWrite === null, "cross-tenant setMemberRole must return null");

  // CROSS-TENANT DELETE: deprovisionMember scoped to wsA cannot remove dave.
  const crossDelete = await deprovisionMember(aAuth!.workspaceId, bMember.user_id);
  ok(crossDelete === false, "cross-tenant deprovisionMember must return false");

  // Dave still present in wsB.
  const daveStill = await findMember(wsB.id, bMember.user_id);
  ok(daveStill !== null && daveStill.role === "viewer", "dave still in wsB after cross-tenant attacks");

  // Listing is also tenant-scoped: wsA list never contains wsB members.
  const aList = await listMembers(wsA.id);
  ok(aList.every((m) => m.email !== "dave@beta.test"), "wsA list excludes dave");
  ok(aList.some((m) => m.email === "carla@acme.test"), "wsA list includes carla");
  ok(aList.some((m) => m.email === "alice@acme.test"), "wsA list includes alice owner");

  // Re-provision carla with a new role: same user_id, role updated.
  const carlaUpdate = await provisionMember(wsA.id, "carla@acme.test", "viewer");
  ok(carlaUpdate.user_id === aMember.user_id, "re-provision reuses same user_id");
  ok(!carlaUpdate.joined, "re-provision does not duplicate membership");
  const carlaAfter = await findMember(wsA.id, aMember.user_id);
  ok(carlaAfter?.role === "viewer", "role updated to viewer");

  // Cannot demote the last owner of wsA.
  let demoteThrew = false;
  try {
    await setMemberRole(wsA.id, aliceOwner.id, "viewer");
  } catch {
    demoteThrew = true;
  }
  ok(demoteThrew, "demoting last owner must throw");

  // Cannot deprovision the last owner of wsA.
  let removeThrew = false;
  try {
    await deprovisionMember(wsA.id, aliceOwner.id);
  } catch {
    removeThrew = true;
  }
  ok(removeThrew, "deprovisioning last owner must throw");

  // Revoking a token blocks subsequent verification.
  await scim.revokeToken(wsA.id, aTok.token.id);
  const reverify = await scim.verifyToken(aTok.plaintext, "10.0.0.1");
  ok(reverify === null, "revoked token no longer validates");

  // Cross-tenant revoke is a no-op (wsB token cannot revoke wsA token).
  const crossRevoke = await scim.revokeToken(wsB.id, aTok.token.id);
  ok(!crossRevoke, "cross-tenant revoke returns false");

  // last_used_at + use_count incremented on bToken.
  const bList = await scim.listForWorkspace(wsB.id);
  const stored = bList.find((t) => t.id === bTok.token.id)!;
  ok(stored.use_count === 1, "use_count incremented on verify");
  ok(stored.last_used_ip === "10.0.0.2", "last_used_ip recorded");

  console.log("OK: scim-store cross-tenant isolation + provisioning checks passed");
  rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
