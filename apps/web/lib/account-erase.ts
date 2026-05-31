/**
 * GDPR / CCPA right-to-erasure orchestrator.
 *
 * Permanently deletes a single user account end-to-end:
 *   1. Plan membership impact (refuse if the user is the sole owner of any
 *      shared workspace).
 *   2. Tombstone every note authored by the user (notes-store keeps the
 *      run reference but strips author + body).
 *   3. Remove memberships and tear down any workspace the user owned alone.
 *   4. Bump session_gen so every outstanding cookie is rejected immediately.
 *   5. Delete the user record + unconsumed magic-link tokens.
 *
 * Steps 2-5 are best-effort; the caller writes one consolidated audit log
 * entry. Returns a report describing what was removed.
 *
 * Workspace-wide data files (runs.jsonl, api-keys.json, etc.) are NOT
 * deleted here - they belong to the workspace, not the user, and on shared
 * workspaces other members still need them. Users who want to nuke the
 * whole workspace use POST /api/settings/wipe before deleting their account.
 */
import {
  deleteUserRecord,
  bumpSessionGen,
  getUserById,
  type UserRecord,
} from "./users-store";
import {
  planUserErasure,
  eraseUserFromWorkspaces,
  type MembershipImpact,
  type ErasureReport,
} from "./workspaces-store";
import { purgeNotesForUser } from "./notes-store";

export interface AccountErasurePreview {
  user_id: string;
  email: string;
  created_at: number;
  memberships: MembershipImpact[];
  blockers: MembershipImpact[];
  can_erase: boolean;
  confirm_phrase: string;
}

export const CONFIRM_PHRASE = "DELETE MY ACCOUNT";

export async function previewAccountErasure(
  userId: string,
): Promise<AccountErasurePreview | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  const memberships = await planUserErasure(userId);
  const blockers = memberships.filter((m) => m.action === "blocked");
  return {
    user_id: user.id,
    email: user.email,
    created_at: user.created_at,
    memberships,
    blockers,
    can_erase: blockers.length === 0,
    confirm_phrase: CONFIRM_PHRASE,
  };
}

export interface AccountErasureResult {
  user_id: string;
  email: string;
  workspaces: ErasureReport;
  notes_tombstoned: number;
  sessions_revoked_at: number | null;
}

export class AccountErasureBlocked extends Error {
  blockers: MembershipImpact[];
  constructor(blockers: MembershipImpact[]) {
    super("account erasure blocked: sole owner of shared workspace(s)");
    this.blockers = blockers;
  }
}

export async function eraseAccount(
  user: UserRecord,
): Promise<AccountErasureResult> {
  const plan = await planUserErasure(user.id);
  const blockers = plan.filter((m) => m.action === "blocked");
  if (blockers.length > 0) throw new AccountErasureBlocked(blockers);

  const notes_tombstoned = await purgeNotesForUser(user.id);
  const workspaces = await eraseUserFromWorkspaces(user.id);
  const bumped = await bumpSessionGen(user.id);
  const sessions_revoked_at = bumped?.sessions_revoked_at ?? null;
  await deleteUserRecord(user.id);
  return {
    user_id: user.id,
    email: user.email,
    workspaces,
    notes_tombstoned,
    sessions_revoked_at,
  };
}
