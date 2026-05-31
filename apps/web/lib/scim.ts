/**
 * SCIM 2.0 (RFC 7643/7644) helpers shared across /scim/v2/* routes.
 *
 * Every SCIM request is authenticated by a workspace-scoped bearer token
 * (see scim-store.ts). The token alone determines which workspace the
 * caller may operate on; there is no cross-tenant verb in this surface.
 *
 * SCIM error responses follow urn:ietf:params:scim:api:messages:2.0:Error
 * and SCIM list responses follow urn:ietf:params:scim:api:messages:2.0:ListResponse.
 */
import { NextRequest, NextResponse } from "next/server";
import type { Member, Role } from "@/lib/workspaces-store";
import { isRole } from "@/lib/workspaces-store";
import { verifyToken as verifyScimToken } from "@/lib/scim-store";
import { getUserById } from "@/lib/users-store";

export const SCIM_CONTENT_TYPE = "application/scim+json";

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ENTERPRISE_USER_EXT =
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

/**
 * The three SCIM Group display names this workspace exposes. They map
 * 1-to-1 to internal roles. Identity providers create assignments by
 * adding a SCIM user to one of these groups.
 */
export const SCIM_GROUP_NAMES = ["owners", "editors", "viewers"] as const;
export type ScimGroupName = (typeof SCIM_GROUP_NAMES)[number];
const GROUP_NAME_TO_ROLE: Record<ScimGroupName, Role> = {
  owners: "owner",
  editors: "editor",
  viewers: "viewer",
};
const ROLE_TO_GROUP_NAME: Record<Role, ScimGroupName> = {
  owner: "owners",
  editor: "editors",
  viewer: "viewers",
};

/**
 * Encode a workspace-scoped group id. SCIM consumers treat ids as opaque,
 * so embedding the workspace prevents an IdP cache from accidentally
 * crossing tenants if a token is later reissued for a different workspace.
 */
export function makeGroupId(workspaceId: string, name: ScimGroupName): string {
  return `${workspaceId}:${name}`;
}
export function parseGroupId(
  id: string,
): { workspaceId: string; name: ScimGroupName } | null {
  const idx = id.lastIndexOf(":");
  if (idx <= 0) return null;
  const ws = id.slice(0, idx);
  const name = id.slice(idx + 1).toLowerCase();
  if (!(SCIM_GROUP_NAMES as readonly string[]).includes(name)) return null;
  return { workspaceId: ws, name: name as ScimGroupName };
}
export function roleForGroupName(name: ScimGroupName): Role {
  return GROUP_NAME_TO_ROLE[name];
}
export function groupNameForRole(role: Role): ScimGroupName {
  return ROLE_TO_GROUP_NAME[role];
}

export function renderScimGroup(
  workspaceId: string,
  name: ScimGroupName,
  members: Member[],
  baseUrl: string,
): Record<string, unknown> {
  const role = GROUP_NAME_TO_ROLE[name];
  const groupMembers = members
    .filter((m) => m.role === role)
    .map((m) => ({
      value: m.user_id,
      display: m.email,
      $ref: `${baseUrl}/scim/v2/Users/${m.user_id}`,
      type: "User",
    }));
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: makeGroupId(workspaceId, name),
    externalId: name,
    displayName: name,
    members: groupMembers,
    meta: {
      resourceType: "Group",
      location: `${baseUrl}/scim/v2/Groups/${makeGroupId(workspaceId, name)}`,
    },
  };
}

/**
 * Map our internal `Role` to a SCIM Group membership name. Identity
 * providers display this on the User detail page.
 */
const ROLE_TO_GROUP: Record<Role, string> = {
  owner: "owners",
  editor: "editors",
  viewer: "viewers",
};
const GROUP_TO_ROLE: Record<string, Role> = {
  owners: "owner",
  editors: "editor",
  viewers: "viewer",
  owner: "owner",
  editor: "editor",
  viewer: "viewer",
  admin: "editor",
  member: "editor",
};

export function roleFromGroupName(name: unknown): Role | null {
  if (typeof name !== "string") return null;
  const k = name.trim().toLowerCase();
  return GROUP_TO_ROLE[k] ?? null;
}

export function getClientIp(req: NextRequest): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

export interface ScimAuth {
  workspaceId: string;
  tokenId: string;
}

/**
 * Extract and verify the SCIM bearer token. Returns null when no valid
 * token is present.
 */
export async function authenticateScim(
  req: NextRequest,
): Promise<ScimAuth | null> {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const ip = getClientIp(req);
  return await verifyScimToken(m[1].trim(), ip);
}

export function scimError(
  status: number,
  detail: string,
  scimType?: string,
): NextResponse {
  return NextResponse.json(
    {
      schemas: [SCIM_ERROR_SCHEMA],
      detail,
      status: String(status),
      ...(scimType ? { scimType } : {}),
    },
    { status, headers: { "content-type": SCIM_CONTENT_TYPE } },
  );
}

export function scimJson(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "content-type": SCIM_CONTENT_TYPE, ...(extraHeaders ?? {}) },
  });
}

/**
 * Render a member as a SCIM 2.0 User resource. SCIM treats `userName` as
 * the unique handle the IdP uses to refer to the user; we use the email,
 * which is also the natural login identifier in this app.
 */
export function memberToScimUser(
  member: Member,
  options: { baseUrl: string; createdAt?: number },
): Record<string, unknown> {
  const localPart = member.email.split("@")[0] ?? member.email;
  return {
    schemas: [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_EXT],
    id: member.user_id,
    externalId: member.user_id,
    userName: member.email,
    active: true,
    name: {
      formatted: localPart,
      familyName: "",
      givenName: localPart,
    },
    emails: [
      {
        value: member.email,
        type: "work",
        primary: true,
      },
    ],
    groups: [
      {
        value: ROLE_TO_GROUP[member.role],
        display: ROLE_TO_GROUP[member.role],
        type: "direct",
      },
    ],
    [SCIM_ENTERPRISE_USER_EXT]: {
      department: ROLE_TO_GROUP[member.role],
    },
    meta: {
      resourceType: "User",
      created: new Date(options.createdAt ?? member.joined_at).toISOString(),
      lastModified: new Date(member.joined_at).toISOString(),
      location: `${options.baseUrl}/scim/v2/Users/${member.user_id}`,
    },
  };
}

/**
 * Parse a single SCIM filter clause of the form
 *   userName eq "alice@example.com"
 * which is the only filter shape providers actually rely on for
 * pre-provisioning lookups. Returns null for any other shape; the route
 * then falls back to returning a full (paginated) list.
 */
export function parseUserNameEq(filter: string | null): string | null {
  if (!filter) return null;
  // Loose parse: providers send these with various capitalisations and
  // either single or double quotes.
  const m = filter.match(/^\s*userName\s+eq\s+"([^"]+)"\s*$/i);
  if (m) return m[1].toLowerCase();
  const m2 = filter.match(/^\s*userName\s+eq\s+'([^']+)'\s*$/i);
  if (m2) return m2[1].toLowerCase();
  return null;
}

export function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function baseUrlOf(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

/**
 * Parse a single SCIM filter clause of the form
 *   displayName eq "editors"
 * which is what providers use to look up Groups by name. Returns the
 * lowercase value when matched, else null.
 */
export function parseDisplayNameEq(filter: string | null): string | null {
  if (!filter) return null;
  const m = filter.match(/^\s*displayName\s+eq\s+"([^"]+)"\s*$/i);
  if (m) return m[1].toLowerCase();
  const m2 = filter.match(/^\s*displayName\s+eq\s+'([^']+)'\s*$/i);
  if (m2) return m2[1].toLowerCase();
  return null;
}

// Re-export to keep route imports concise.
export { isRole, getUserById };
