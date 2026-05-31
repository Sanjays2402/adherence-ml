/**
 * Workspace data retention enforcement.
 *
 * Every workspace owner can set `runs_retention_days` on their workspace
 * security policy. Calling `enforceRetention` for a workspace deletes any
 * run owned by a current member of that workspace whose `created_at` is
 * older than the cutoff. This runs on demand (POST /api/retention/tick)
 * and is intended to be invoked by a scheduled job for production use.
 *
 * Cross-tenant isolation: a tick for workspace A can ONLY delete runs
 * whose owner is a current member of A. A run owned by a user who is not
 * a member of A is never touched, even if it is older than the cutoff.
 *
 * Audit log entries are intentionally NOT purged: they are append-only and
 * hash-chained per SOC2 guidance.
 */
import {
  getWorkspacePolicy,
  listMembers,
  normalizeRetentionDays,
} from "@/lib/workspaces-store";
import { listAllRuns, deleteRuns } from "@/lib/runs-store";

export interface RetentionResult {
  workspace_id: string;
  retention_days: number | null;
  cutoff_ms: number | null;
  candidate_count: number;
  deleted_count: number;
}

/**
 * Enforce the retention policy for a single workspace. When the workspace
 * has no retention policy set, returns `{ deleted_count: 0 }` without
 * touching any runs.
 */
export async function enforceRetention(
  workspaceId: string,
  now: number = Date.now(),
): Promise<RetentionResult> {
  const policy = await getWorkspacePolicy(workspaceId);
  const days = normalizeRetentionDays(
    (policy as { runs_retention_days?: unknown } | null)?.runs_retention_days,
  );
  if (!days) {
    return {
      workspace_id: workspaceId,
      retention_days: null,
      cutoff_ms: null,
      candidate_count: 0,
      deleted_count: 0,
    };
  }
  const cutoff = now - days * 86_400_000;
  const members = await listMembers(workspaceId);
  const memberUserIds = new Set(members.map((m) => m.user_id));
  if (memberUserIds.size === 0) {
    return {
      workspace_id: workspaceId,
      retention_days: days,
      cutoff_ms: cutoff,
      candidate_count: 0,
      deleted_count: 0,
    };
  }

  const all = await listAllRuns();
  const inScope = all.filter(
    (r) =>
      r.user_id !== null &&
      memberUserIds.has(r.user_id) &&
      r.created_at < cutoff,
  );

  const ids = inScope.map((r) => r.id);
  const deleted = ids.length > 0 ? await deleteRuns(ids) : 0;
  return {
    workspace_id: workspaceId,
    retention_days: days,
    cutoff_ms: cutoff,
    candidate_count: inScope.length,
    deleted_count: deleted,
  };
}

/** Compute the cutoff ms for retention; null when retention is disabled. */
export function retentionCutoff(
  days: number | null,
  now: number = Date.now(),
): number | null {
  const d = normalizeRetentionDays(days);
  return d ? now - d * 86_400_000 : null;
}
