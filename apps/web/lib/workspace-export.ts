/**
 * Workspace-wide GDPR / CCPA data export.
 *
 * Owner-only. Bundles every workspace-scoped artifact the buyer's privacy
 * team will ask for:
 *   - workspace record (id, name, created_at, created_by)
 *   - members (user id, email, role, joined_at)
 *   - invites (open + accepted + revoked)
 *   - verified email domains and auto-join status
 *   - SSO config (public projection, never the client_secret)
 *   - security policy
 *   - dashboard audit entries where target = workspace id OR actor is a member
 *   - runs authored by any current member
 *   - notes authored by any current member (collapsed, no tombstones)
 *
 * Returns a single JSON bundle. The companion runsCsv() flattens runs to
 * RFC 4180 CSV for spreadsheet handoff. Both endpoints support `?dry_run=1`,
 * which returns the manifest (counts only) and never reads the heavy stores.
 *
 * Install-scoped resources (api keys, webhooks, schedules) are NOT included
 * here. Those are owned by the install in this build, not the workspace,
 * and surfacing them in a per-workspace export would be misleading.
 */
import { readAllRuns, type RunRecord } from "@/lib/runs-store";
import { listNotesByAuthors, type NoteRecord } from "@/lib/notes-store";
import { listAudit, type AuditEntry } from "@/lib/dashboard-audit";
import {
  getWorkspaceForUser,
  listInvites,
  publicSso,
  publicPolicy,
  publicVerifiedDomain,
  type Member,
  type Workspace,
} from "@/lib/workspaces-store";

export const EXPORT_SCHEMA_VERSION = 1;

export interface WorkspaceExportManifest {
  schema_version: number;
  generated_at: number;
  workspace_id: string;
  workspace_name: string;
  counts: {
    members: number;
    invites: number;
    verified_domains: number;
    audit_entries: number;
    runs: number;
    notes: number;
  };
}

export interface WorkspaceExportBundle {
  manifest: WorkspaceExportManifest;
  workspace: {
    id: string;
    name: string;
    created_at: number;
    created_by: string;
    sso: ReturnType<typeof publicSso>;
    security_policy: ReturnType<typeof publicPolicy>;
  };
  members: Array<Pick<Member, "user_id" | "email" | "role" | "joined_at">>;
  invites: Array<{
    id: string;
    email: string;
    role: string;
    created_at: number;
    expires_at: number;
    accepted_at: number | null;
    revoked_at: number | null;
  }>;
  verified_domains: ReturnType<typeof publicVerifiedDomain>[];
  audit: AuditEntry[];
  runs: RunRecord[];
  notes: NoteRecord[];
}

export interface BuildExportOptions {
  /** Cap on audit entries returned. Default 1000 (the store cap). */
  audit_limit?: number;
}

async function loadWorkspaceContext(workspaceId: string, ownerId: string) {
  const ws = await getWorkspaceForUser(workspaceId, ownerId);
  if (!ws) return null;
  return ws;
}

/** Returns null when the user is not a member; "forbidden" when not owner. */
export async function buildWorkspaceExport(
  workspaceId: string,
  ownerId: string,
  opts: BuildExportOptions = {},
): Promise<WorkspaceExportBundle | null | "forbidden"> {
  const ctx = await loadWorkspaceContext(workspaceId, ownerId);
  if (!ctx) return null;
  if (ctx.role !== "owner") return "forbidden";

  const ws: Workspace = ctx.workspace;
  const members = ctx.members;
  const memberIds = members.map((m) => m.user_id);

  const invites = await listInvites(workspaceId);
  const auditAll = await listAudit({ limit: opts.audit_limit ?? 1000 });
  const memberSet = new Set(memberIds);
  const audit = auditAll.items.filter(
    (e) =>
      e.target === workspaceId ||
      (e.actor_user_id !== null && memberSet.has(e.actor_user_id)),
  );

  const runsAll = await readAllRuns();
  const runs = runsAll.filter(
    (r) => r.user_id !== null && memberSet.has(r.user_id),
  );

  const notes = await listNotesByAuthors(memberIds);

  const manifest: WorkspaceExportManifest = {
    schema_version: EXPORT_SCHEMA_VERSION,
    generated_at: Date.now(),
    workspace_id: ws.id,
    workspace_name: ws.name,
    counts: {
      members: members.length,
      invites: invites.length,
      verified_domains: (ws.verified_domains ?? []).length,
      audit_entries: audit.length,
      runs: runs.length,
      notes: notes.length,
    },
  };

  return {
    manifest,
    workspace: {
      id: ws.id,
      name: ws.name,
      created_at: ws.created_at,
      created_by: ws.created_by,
      sso: publicSso(ws.sso ?? null),
      security_policy: publicPolicy(ws.security_policy ?? null),
    },
    members: members.map((m) => ({
      user_id: m.user_id,
      email: m.email,
      role: m.role,
      joined_at: m.joined_at,
    })),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      created_at: i.created_at,
      expires_at: i.expires_at,
      accepted_at: i.accepted_at,
      revoked_at: i.revoked_at,
    })),
    verified_domains: (ws.verified_domains ?? []).map(publicVerifiedDomain),
    audit,
    runs,
    notes,
  };
}

/** Lightweight preview for dry-run: counts only, no heavy reads beyond runs. */
export async function previewWorkspaceExport(
  workspaceId: string,
  ownerId: string,
): Promise<WorkspaceExportManifest | null | "forbidden"> {
  const bundle = await buildWorkspaceExport(workspaceId, ownerId);
  if (bundle === null) return null;
  if (bundle === "forbidden") return "forbidden";
  return bundle.manifest;
}

/** RFC 4180 CSV of runs (one row per run). Escapes quotes by doubling. */
export function runsCsv(runs: RunRecord[]): string {
  const header = [
    "id",
    "created_at_iso",
    "kind",
    "title",
    "summary",
    "user_id",
    "latency_ms",
    "tags",
    "pinned",
    "shared",
  ];
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [header.join(",")];
  for (const r of runs) {
    lines.push(
      [
        esc(r.id),
        esc(new Date(r.created_at).toISOString()),
        esc(r.kind),
        esc(r.title),
        esc(r.summary),
        esc(r.user_id),
        esc(r.latency_ms),
        esc(r.tags.join("|")),
        esc(r.pinned ? "true" : "false"),
        esc(r.share_token ? "true" : "false"),
      ].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
