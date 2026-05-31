/**
 * SCIM 2.0 Users collection.
 *
 *   GET  /scim/v2/Users[?filter=userName eq "..."][&startIndex=1&count=100]
 *   POST /scim/v2/Users   -> create-or-update member by userName
 *
 * Every request is authenticated by a workspace-scoped bearer token. The
 * token alone determines `workspaceId`; the request body cannot escape it.
 * All mutations are written to the hash-chained dashboard audit log.
 */
import { NextRequest } from "next/server";
import {
  SCIM_LIST_SCHEMA,
  authenticateScim,
  baseUrlOf,
  clampInt,
  getUserById,
  memberToScimUser,
  parseUserNameEq,
  roleFromGroupName,
  scimError,
  scimJson,
} from "@/lib/scim";
import {
  listMembers,
  provisionMember,
  type Role,
} from "@/lib/workspaces-store";
import { recordAudit } from "@/lib/dashboard-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  const url = new URL(req.url);
  const filter = url.searchParams.get("filter");
  const startIndex = clampInt(url.searchParams.get("startIndex"), 1, 1, 1_000_000);
  const count = clampInt(url.searchParams.get("count"), 100, 0, 200);
  const base = baseUrlOf(req);

  // Tenant-scoped read. listMembers() never returns rows from another workspace.
  const all = await listMembers(auth.workspaceId);

  let filtered = all;
  const userNameEq = parseUserNameEq(filter);
  if (userNameEq) {
    filtered = all.filter((m) => m.email === userNameEq);
  } else if (filter && filter.trim()) {
    // We declared filter=true but only support `userName eq` for now. Any
    // other operator is a soft-fail: SCIM 400 with scimType=invalidFilter.
    return scimError(400, `unsupported filter: ${filter}`, "invalidFilter");
  }

  const page = filtered.slice(startIndex - 1, startIndex - 1 + count);
  const resources = page.map((m) => memberToScimUser(m, { baseUrl: base }));
  return scimJson(200, {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: filtered.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: resources,
  });
}

interface ScimUserPost {
  userName?: unknown;
  active?: unknown;
  emails?: Array<{ value?: unknown; primary?: unknown; type?: unknown }>;
  groups?: Array<{ value?: unknown; display?: unknown }>;
  // Enterprise extension or non-standard "role" field both accepted.
  ["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"]?: {
    department?: unknown;
  };
  roles?: Array<{ value?: unknown; type?: unknown; primary?: unknown }>;
}

function pickEmail(body: ScimUserPost): string | null {
  if (typeof body.userName === "string" && body.userName.includes("@")) {
    return body.userName.trim().toLowerCase();
  }
  if (Array.isArray(body.emails)) {
    const primary = body.emails.find((e) => e?.primary === true);
    if (primary && typeof primary.value === "string") return primary.value.trim().toLowerCase();
    const first = body.emails.find((e) => typeof e?.value === "string");
    if (first && typeof first.value === "string") return first.value.trim().toLowerCase();
  }
  return null;
}

function pickRole(body: ScimUserPost): Role {
  // Prefer SCIM groups, then the enterprise department extension, then
  // top-level roles[]. Default to viewer.
  if (Array.isArray(body.groups)) {
    for (const g of body.groups) {
      const r = roleFromGroupName(g?.display ?? g?.value);
      if (r) return r;
    }
  }
  const ext = body["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"];
  if (ext && typeof ext.department === "string") {
    const r = roleFromGroupName(ext.department);
    if (r) return r;
  }
  if (Array.isArray(body.roles)) {
    for (const r of body.roles) {
      const role = roleFromGroupName(r?.value);
      if (role) return role;
    }
  }
  return "viewer";
}

export async function POST(req: NextRequest) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");

  let body: ScimUserPost;
  try {
    body = (await req.json()) as ScimUserPost;
  } catch {
    return scimError(400, "invalid JSON body", "invalidSyntax");
  }
  const email = pickEmail(body);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return scimError(400, "userName or emails[].value with a valid address is required", "invalidValue");
  }
  const role = pickRole(body);

  // If `active: false` is sent on create, IdPs expect us to suspend rather
  // than provision. Most providers don't do this, but it's spec-correct.
  if (body.active === false) {
    return scimError(400, "cannot create an inactive user; PATCH active=false on an existing user to deactivate", "invalidValue");
  }

  try {
    const result = await provisionMember(auth.workspaceId, email, role);
    const user = await getUserById(result.user_id);
    const created = !!user && user.created_at === user.last_login_at;
    await recordAudit({
      action: "scim.user.provision",
      target: result.user_id,
      outcome: "success",
      actor: { user_id: null, email: `scim:${auth.tokenId}` },
      request: req,
      metadata: {
        workspace_id: auth.workspaceId,
        email,
        role,
        member_created: result.joined,
        user_created: created,
        scim_token_id: auth.tokenId,
      },
    });
    const base = baseUrlOf(req);
    const member = {
      workspace_id: auth.workspaceId,
      user_id: result.user_id,
      email,
      role,
      joined_at: Date.now(),
    };
    return scimJson(
      result.joined ? 201 : 200,
      memberToScimUser(member, { baseUrl: base }),
      result.joined
        ? { location: `${base}/scim/v2/Users/${result.user_id}` }
        : undefined,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "provision failed";
    await recordAudit({
      action: "scim.user.provision",
      target: email,
      outcome: "failure",
      actor: { user_id: null, email: `scim:${auth.tokenId}` },
      request: req,
      metadata: {
        workspace_id: auth.workspaceId,
        email,
        role,
        error: msg,
        scim_token_id: auth.tokenId,
      },
    });
    return scimError(400, msg, "invalidValue");
  }
}
