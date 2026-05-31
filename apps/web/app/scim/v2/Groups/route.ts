/**
 * SCIM 2.0 Groups collection.
 *
 *   GET /scim/v2/Groups[?filter=displayName eq "editors"][&startIndex=1&count=100]
 *
 * Groups are fixed per workspace: owners, editors, viewers. Identity
 * providers assign a user to a role by PATCHing membership of one of these
 * groups (see /scim/v2/Groups/{id}). POST is not supported because new
 * groups cannot be created; we return 403 with scimType=mutability.
 *
 * Every request is authenticated by a workspace-scoped bearer token. The
 * token alone determines `workspaceId`; nothing in the URL or body can
 * escape it.
 */
import { NextRequest } from "next/server";
import {
  SCIM_GROUP_NAMES,
  SCIM_LIST_SCHEMA,
  type ScimGroupName,
  authenticateScim,
  baseUrlOf,
  clampInt,
  parseDisplayNameEq,
  renderScimGroup,
  scimError,
  scimJson,
} from "@/lib/scim";
import { listMembers } from "@/lib/workspaces-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  const url = new URL(req.url);
  const filter = url.searchParams.get("filter");
  const startIndex = clampInt(url.searchParams.get("startIndex"), 1, 1, 1_000_000);
  const countParam = url.searchParams.get("count");
  const count = countParam === null ? 100 : clampInt(countParam, 100, 0, 200);
  const base = baseUrlOf(req);

  let names: ScimGroupName[] = [...SCIM_GROUP_NAMES];
  const displayEq = parseDisplayNameEq(filter);
  if (displayEq) {
    names = names.filter((n) => n === displayEq);
  } else if (filter && filter.trim()) {
    return scimError(400, `unsupported filter: ${filter}`, "invalidFilter");
  }

  // Tenant-scoped read. listMembers() never returns rows from another workspace.
  const members = await listMembers(auth.workspaceId);
  const page = names.slice(startIndex - 1, startIndex - 1 + count);
  const resources = page.map((n) =>
    renderScimGroup(auth.workspaceId, n, members, base),
  );
  return scimJson(200, {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: names.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: resources,
  });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  return scimError(
    403,
    "groups are fixed (owners, editors, viewers); new groups cannot be created",
    "mutability",
  );
}
