/**
 * SCIM 2.0 single-user resource.
 *
 *   GET    /scim/v2/Users/{id}  -> read one workspace member
 *   PUT    /scim/v2/Users/{id}  -> full replace (role / active)
 *   PATCH  /scim/v2/Users/{id}  -> partial update (Okta + Azure AD do this)
 *   DELETE /scim/v2/Users/{id}  -> deprovision member
 *
 * Cross-tenant requests are 404. The workspace is fixed by the bearer token,
 * not by anything in the URL or body.
 */
import { NextRequest } from "next/server";
import {
  SCIM_PATCH_SCHEMA,
  authenticateScim,
  baseUrlOf,
  memberToScimUser,
  roleFromGroupName,
  scimError,
  scimJson,
} from "@/lib/scim";
import {
  deprovisionMember,
  findMember,
  setMemberRole,
  type Role,
} from "@/lib/workspaces-store";
import { recordAudit } from "@/lib/dashboard-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  const { id } = await params;
  const m = await findMember(auth.workspaceId, id);
  if (!m) return scimError(404, `user ${id} not found`);
  return scimJson(200, memberToScimUser(m, { baseUrl: baseUrlOf(req) }));
}

interface PutBody {
  active?: unknown;
  userName?: unknown;
  emails?: Array<{ value?: unknown; primary?: unknown }>;
  groups?: Array<{ value?: unknown; display?: unknown }>;
  ["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"]?: {
    department?: unknown;
  };
  roles?: Array<{ value?: unknown }>;
}

function roleFromBody(body: PutBody): Role | null {
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
  return null;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  const { id } = await params;
  const existing = await findMember(auth.workspaceId, id);
  if (!existing) return scimError(404, `user ${id} not found`);

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return scimError(400, "invalid JSON body", "invalidSyntax");
  }

  // active:false on PUT means deprovision; spec-compliant deactivation path.
  if (body.active === false) {
    try {
      await deprovisionMember(auth.workspaceId, id);
      await recordAudit({
        action: "scim.user.deactivate",
        target: id,
        outcome: "success",
        actor: { user_id: null, email: `scim:${auth.tokenId}` },
        request: req,
        metadata: {
          workspace_id: auth.workspaceId,
          email: existing.email,
          via: "PUT active=false",
          scim_token_id: auth.tokenId,
        },
      });
      return scimJson(200, {
        ...memberToScimUser(existing, { baseUrl: baseUrlOf(req) }),
        active: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "deprovision failed";
      await recordAudit({
        action: "scim.user.deactivate",
        target: id,
        outcome: "failure",
        actor: { user_id: null, email: `scim:${auth.tokenId}` },
        request: req,
        metadata: { workspace_id: auth.workspaceId, error: msg, scim_token_id: auth.tokenId },
      });
      return scimError(400, msg);
    }
  }

  const role = roleFromBody(body);
  if (role && role !== existing.role) {
    try {
      const updated = await setMemberRole(auth.workspaceId, id, role);
      if (!updated) return scimError(404, `user ${id} not found`);
      await recordAudit({
        action: "scim.user.role_update",
        target: id,
        outcome: "success",
        actor: { user_id: null, email: `scim:${auth.tokenId}` },
        request: req,
        metadata: {
          workspace_id: auth.workspaceId,
          email: existing.email,
          before: existing.role,
          after: role,
          scim_token_id: auth.tokenId,
        },
      });
      return scimJson(200, memberToScimUser(updated, { baseUrl: baseUrlOf(req) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "role update failed";
      await recordAudit({
        action: "scim.user.role_update",
        target: id,
        outcome: "failure",
        actor: { user_id: null, email: `scim:${auth.tokenId}` },
        request: req,
        metadata: { workspace_id: auth.workspaceId, error: msg, scim_token_id: auth.tokenId },
      });
      return scimError(400, msg);
    }
  }
  // No-op PUT (idempotent).
  return scimJson(200, memberToScimUser(existing, { baseUrl: baseUrlOf(req) }));
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  const { id } = await params;
  const existing = await findMember(auth.workspaceId, id);
  if (!existing) return scimError(404, `user ${id} not found`);

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

  let deactivate = false;
  let newRole: Role | null = null;
  for (const op of body.Operations) {
    const opName = (op.op ?? "").toLowerCase();
    if (!["add", "replace", "remove"].includes(opName)) {
      return scimError(400, `unsupported op: ${op.op}`, "invalidSyntax");
    }
    const pathLower = (op.path ?? "").toLowerCase();
    // Azure AD sends a single op with no path and a value object.
    if (!op.path && op.value && typeof op.value === "object") {
      const v = op.value as Record<string, unknown>;
      if (v.active === false) deactivate = true;
      if (Array.isArray(v.groups)) {
        for (const g of v.groups as Array<{ value?: unknown; display?: unknown }>) {
          const r = roleFromGroupName(g?.display ?? g?.value);
          if (r) newRole = r;
        }
      }
      const ext = v["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"] as
        | { department?: unknown }
        | undefined;
      if (ext && typeof ext.department === "string") {
        const r = roleFromGroupName(ext.department);
        if (r) newRole = r;
      }
      continue;
    }
    if (pathLower === "active") {
      if (op.value === false || op.value === "False" || op.value === "false") {
        deactivate = true;
      }
      continue;
    }
    if (pathLower === "groups" || pathLower.startsWith("groups[")) {
      const v = op.value;
      if (Array.isArray(v)) {
        for (const g of v as Array<{ value?: unknown; display?: unknown }>) {
          const r = roleFromGroupName(g?.display ?? g?.value);
          if (r) newRole = r;
        }
      } else if (typeof v === "string") {
        const r = roleFromGroupName(v);
        if (r) newRole = r;
      }
      continue;
    }
    if (
      pathLower ===
      "urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:department"
    ) {
      const r = roleFromGroupName(op.value);
      if (r) newRole = r;
      continue;
    }
    // Other paths are accepted and ignored to stay forward-compatible.
  }

  if (deactivate) {
    try {
      await deprovisionMember(auth.workspaceId, id);
      await recordAudit({
        action: "scim.user.deactivate",
        target: id,
        outcome: "success",
        actor: { user_id: null, email: `scim:${auth.tokenId}` },
        request: req,
        metadata: {
          workspace_id: auth.workspaceId,
          email: existing.email,
          via: "PATCH active=false",
          scim_token_id: auth.tokenId,
        },
      });
      return scimJson(200, {
        ...memberToScimUser(existing, { baseUrl: baseUrlOf(req) }),
        active: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "deprovision failed";
      await recordAudit({
        action: "scim.user.deactivate",
        target: id,
        outcome: "failure",
        actor: { user_id: null, email: `scim:${auth.tokenId}` },
        request: req,
        metadata: { workspace_id: auth.workspaceId, error: msg, scim_token_id: auth.tokenId },
      });
      return scimError(400, msg);
    }
  }
  if (newRole && newRole !== existing.role) {
    try {
      const updated = await setMemberRole(auth.workspaceId, id, newRole);
      if (!updated) return scimError(404, `user ${id} not found`);
      await recordAudit({
        action: "scim.user.role_update",
        target: id,
        outcome: "success",
        actor: { user_id: null, email: `scim:${auth.tokenId}` },
        request: req,
        metadata: {
          workspace_id: auth.workspaceId,
          email: existing.email,
          before: existing.role,
          after: newRole,
          scim_token_id: auth.tokenId,
        },
      });
      return scimJson(200, memberToScimUser(updated, { baseUrl: baseUrlOf(req) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "role update failed";
      await recordAudit({
        action: "scim.user.role_update",
        target: id,
        outcome: "failure",
        actor: { user_id: null, email: `scim:${auth.tokenId}` },
        request: req,
        metadata: { workspace_id: auth.workspaceId, error: msg, scim_token_id: auth.tokenId },
      });
      return scimError(400, msg);
    }
  }
  return scimJson(200, memberToScimUser(existing, { baseUrl: baseUrlOf(req) }));
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateScim(req);
  if (!auth) return scimError(401, "invalid or missing bearer token");
  const { id } = await params;
  const existing = await findMember(auth.workspaceId, id);
  if (!existing) return scimError(404, `user ${id} not found`);
  try {
    const ok = await deprovisionMember(auth.workspaceId, id);
    if (!ok) return scimError(404, `user ${id} not found`);
    await recordAudit({
      action: "scim.user.delete",
      target: id,
      outcome: "success",
      actor: { user_id: null, email: `scim:${auth.tokenId}` },
      request: req,
      metadata: {
        workspace_id: auth.workspaceId,
        email: existing.email,
        scim_token_id: auth.tokenId,
      },
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "delete failed";
    await recordAudit({
      action: "scim.user.delete",
      target: id,
      outcome: "failure",
      actor: { user_id: null, email: `scim:${auth.tokenId}` },
      request: req,
      metadata: { workspace_id: auth.workspaceId, error: msg, scim_token_id: auth.tokenId },
    });
    return scimError(400, msg);
  }
}
