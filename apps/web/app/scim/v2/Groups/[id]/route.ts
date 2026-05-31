/**
 * SCIM 2.0 single-group resource.
 *
 *   GET   /scim/v2/Groups/{id}  -> read one role group (owners|editors|viewers)
 *   PATCH /scim/v2/Groups/{id}  -> add or remove members (changes their role)
 *
 * Group ids are `{workspaceId}:{name}`. We refuse any id whose workspace
 * portion does not match the bearer token's workspace, so a token for A
 * cannot mutate B's groups even if the IdP cached an old id. Adding a
 * user to a group sets their role to the matching value; removing a user
 * from a group sets their role to viewer (the lowest privilege) so the
 * user remains a member but loses elevated access. We never demote the
 * last owner.
 *
 * PUT and DELETE are not supported: the three role groups are fixed and
 * cannot be created, renamed, or removed.
 */
import { NextRequest } from "next/server";
import {
  SCIM_PATCH_SCHEMA,
  authenticateScim,
  baseUrlOf,
  groupNameForRole,
  parseGroupId,
  renderScimGroup,
  roleForGroupName,
  scimError,
  scimJson,
} from "@/lib/scim";
import {
  findMember,
  listMembers,
  setMemberRole,
} from "@/lib/workspaces-store";
import { recordAudit } from "@/lib/dashboard-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadGroup(req: NextRequest, rawId: string) {
  const auth = await authenticateScim(req);
  if (!auth) return { error: scimError(401, "invalid or missing bearer token") };
  const parsed = parseGroupId(decodeURIComponent(rawId));
  if (!parsed) return { error: scimError(404, `group ${rawId} not found`) };
  // Cross-tenant requests are 404. The workspace is fixed by the bearer
  // token, not by anything in the URL.
  if (parsed.workspaceId !== auth.workspaceId) {
    return { error: scimError(404, `group ${rawId} not found`) };
  }
  return { auth, parsed };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadGroup(req, id);
  if ("error" in r) return r.error;
  const members = await listMembers(r.auth.workspaceId);
  return scimJson(
    200,
    renderScimGroup(r.auth.workspaceId, r.parsed.name, members, baseUrlOf(req)),
  );
}

interface PatchOp {
  op?: string;
  path?: string;
  value?: unknown;
}
interface PatchBody {
  schemas?: string[];
  Operations?: PatchOp[];
}

interface MemberRef {
  value?: unknown;
  display?: unknown;
}

function collectMemberValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value as MemberRef[]) {
      if (v && typeof v.value === "string") out.push(v.value);
    }
    return out;
  }
  if (value && typeof value === "object") {
    const v = value as MemberRef;
    if (typeof v.value === "string") return [v.value];
  }
  if (typeof value === "string") return [value];
  return [];
}

/**
 * Pull user ids out of a SCIM `path` like `members[value eq "u_123"]`,
 * which is the shape Okta and Azure AD use for granular removes.
 */
function parseMembersFilterPath(path: string): string[] {
  const m = path.match(/^members\[value\s+eq\s+["']([^"']+)["']\]$/i);
  return m ? [m[1]] : [];
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: rawId } = await params;
  const r = await loadGroup(req, rawId);
  if ("error" in r) return r.error;
  const { auth, parsed } = r;
  const targetRole = roleForGroupName(parsed.name);

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return scimError(400, "invalid JSON body", "invalidSyntax");
  }
  if (!Array.isArray(body.Operations) || body.Operations.length === 0) {
    return scimError(400, "Operations array required", "invalidSyntax");
  }
  if (Array.isArray(body.schemas) && !body.schemas.includes(SCIM_PATCH_SCHEMA)) {
    return scimError(400, `schemas must include ${SCIM_PATCH_SCHEMA}`, "invalidSyntax");
  }

  // Collect intended membership changes before applying anything; that way
  // a malformed op fails the whole batch instead of leaving partial state.
  const toAdd = new Set<string>();
  const toRemove = new Set<string>();

  for (const op of body.Operations) {
    const opName = (op.op ?? "").toLowerCase();
    if (!["add", "replace", "remove"].includes(opName)) {
      return scimError(400, `unsupported op: ${op.op}`, "invalidSyntax");
    }
    const pathLower = (op.path ?? "").toLowerCase();

    // Filter remove: `members[value eq "u_..."]`
    if (opName === "remove" && pathLower.startsWith("members[")) {
      for (const v of parseMembersFilterPath(op.path ?? "")) toRemove.add(v);
      continue;
    }
    if (pathLower === "members" || pathLower === "") {
      const values = collectMemberValues(op.value);
      if (opName === "remove") {
        // remove with path=members and no value means remove all current
        // members of that role. Map to viewer en-masse later.
        if (values.length === 0 && pathLower === "members") {
          const all = await listMembers(auth.workspaceId);
          for (const m of all) if (m.role === targetRole) toRemove.add(m.user_id);
        } else {
          for (const v of values) toRemove.add(v);
        }
      } else {
        // add / replace
        if (pathLower === "" && op.value && typeof op.value === "object" && !Array.isArray(op.value)) {
          // Azure-style pathless replace body, e.g. { members: [...] }
          const inner = (op.value as { members?: unknown }).members;
          for (const v of collectMemberValues(inner)) toAdd.add(v);
        } else {
          for (const v of values) toAdd.add(v);
        }
        if (opName === "replace" && pathLower === "members") {
          // replace semantics: anyone currently in this role and not in
          // the new set should drop out (mapped to viewer).
          const all = await listMembers(auth.workspaceId);
          for (const m of all) {
            if (m.role === targetRole && !toAdd.has(m.user_id)) {
              toRemove.add(m.user_id);
            }
          }
        }
      }
      continue;
    }

    // Other paths are accepted and ignored to stay forward-compatible.
  }

  // Resolve same-id conflict: add wins (most generous), since a single op
  // adding and removing the same user is almost always a no-op intent.
  for (const v of toAdd) toRemove.delete(v);

  const changes: Array<{ user_id: string; before: string; after: string }> = [];
  const errors: string[] = [];

  for (const userId of toAdd) {
    const existing = await findMember(auth.workspaceId, userId);
    if (!existing) {
      errors.push(`user ${userId} is not a member of this workspace`);
      continue;
    }
    if (existing.role === targetRole) continue;
    try {
      const updated = await setMemberRole(auth.workspaceId, userId, targetRole);
      if (updated) {
        changes.push({ user_id: userId, before: existing.role, after: targetRole });
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "role update failed");
    }
  }
  for (const userId of toRemove) {
    const existing = await findMember(auth.workspaceId, userId);
    if (!existing) continue;
    if (existing.role !== targetRole) continue; // already not in this group
    // Dropping out of a role group means lowest privilege (viewer). This
    // keeps the user in the workspace and avoids a SCIM remove silently
    // deleting an account.
    if (targetRole === "viewer") continue;
    try {
      const updated = await setMemberRole(auth.workspaceId, userId, "viewer");
      if (updated) {
        changes.push({ user_id: userId, before: existing.role, after: "viewer" });
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : "role update failed");
    }
  }

  await recordAudit({
    action: "scim.group.patch",
    target: `${auth.workspaceId}:${parsed.name}`,
    outcome: errors.length === 0 ? "success" : "failure",
    actor: { user_id: null, email: `scim:${auth.tokenId}` },
    request: req,
    metadata: {
      workspace_id: auth.workspaceId,
      group: parsed.name,
      changes,
      errors,
      scim_token_id: auth.tokenId,
    },
  });

  if (errors.length > 0 && changes.length === 0) {
    return scimError(400, errors.join("; "));
  }

  const members = await listMembers(auth.workspaceId);
  return scimJson(
    200,
    renderScimGroup(auth.workspaceId, parsed.name, members, baseUrlOf(req)),
  );
}

export async function PUT(_req: NextRequest) {
  return scimError(
    403,
    "groups are fixed (owners, editors, viewers); use PATCH to change membership",
    "mutability",
  );
}

export async function DELETE(_req: NextRequest) {
  return scimError(
    403,
    "groups are fixed (owners, editors, viewers) and cannot be removed",
    "mutability",
  );
}

// Note: groupNameForRole is imported to keep the type-checker honest that
// roles and group names stay in sync, even though this route doesn't call it.
void groupNameForRole;
