/**
 * Owner-initiated full workspace deletion ("tenant offboarding").
 *
 * Enterprise procurement (GDPR Art. 17, SOC2 CC6.1, ISO 27001 A.8.10)
 * requires a documented, owner-controlled way to permanently remove a
 * tenant's data on demand. This module orchestrates that for every
 * workspace-scoped store this build owns:
 *
 *   - workspaces-store: the workspace row + members + invites + verified
 *     domains + SSO config + security policy (the last three live on the
 *     workspace row so they vanish with it).
 *   - scim-store: every SCIM token whose workspace_id matches.
 *
 * Install-scoped resources (runs, notes, api keys, schedules, webhooks)
 * are intentionally NOT touched here. They belong to the install, not a
 * single workspace, and `POST /api/settings/wipe` is the install-wide
 * eraser for those.
 *
 * Two phase contract:
 *   - preview(): owner-only, never mutates, returns a manifest + the typed
 *     confirmation phrase the caller has to send back verbatim.
 *   - execute(): owner-only, requires the typed confirm phrase. Wrapped
 *     by the route in step-up MFA + dashboard audit. Cross-tenant safe:
 *     every store filters strictly on `workspace_id`.
 */
import {
  deleteWorkspaceFully,
  previewWorkspaceDelete,
  workspaceDeleteConfirmPhrase,
  type WorkspaceDeleteError,
  type WorkspaceDeletePreview,
  type WorkspaceDeleteReport,
} from "./workspaces-store";
import { purgeTokensForWorkspace } from "./scim-store";

export type {
  WorkspaceDeleteError,
  WorkspaceDeletePreview,
  WorkspaceDeleteReport,
};
export { workspaceDeleteConfirmPhrase };

export interface FullWorkspaceDeleteReport extends WorkspaceDeleteReport {
  scim_tokens_removed: number;
}

export async function previewWorkspaceDeletion(
  workspaceId: string,
  callerUserId: string,
): Promise<WorkspaceDeletePreview | null | "forbidden"> {
  return previewWorkspaceDelete(workspaceId, callerUserId);
}

export async function executeWorkspaceDeletion(
  workspaceId: string,
  callerUserId: string,
  confirmPhrase: string,
): Promise<FullWorkspaceDeleteReport | WorkspaceDeleteError> {
  const wsResult = await deleteWorkspaceFully(
    workspaceId,
    callerUserId,
    confirmPhrase,
  );
  if (typeof wsResult === "string") return wsResult;
  // Cascade scim tokens. This MUST run after the workspace row is gone so a
  // racing call to /scim cannot mint a new token that survives the purge.
  const scimRemoved = await purgeTokensForWorkspace(workspaceId);
  return { ...wsResult, scim_tokens_removed: scimRemoved };
}
