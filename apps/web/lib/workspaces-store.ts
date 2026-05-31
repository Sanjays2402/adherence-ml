/**
 * Workspaces store: shared spaces with member roles (owner / editor / viewer)
 * and email invites. File-backed JSON to match the rest of the app, so it
 * deploys with zero infra.
 *
 * On first read for any user the user gets a personal "default" workspace
 * (role=owner) so the rest of the app keeps working even before they invite
 * anyone.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

export type Role = "owner" | "editor" | "viewer";
export const ROLES: Role[] = ["owner", "editor", "viewer"];

export interface Workspace {
  id: string;
  name: string;
  created_at: number;
  created_by: string; // user id
  /**
   * Optional OIDC SSO configuration. When `enforce` is true, every member
   * (and any new sign-in matching one of `allowed_email_domains`) MUST sign
   * in through this workspace's IdP. Magic links and other OAuth providers
   * are refused for those email domains.
   */
  sso?: WorkspaceSso | null;
  /**
   * Optional workspace-wide security policy. The effective policy for a
   * given user is computed across every workspace they belong to:
   *   - `session_max_age_minutes`: minimum across workspaces (tightest wins)
   *   - `require_mfa`: true if ANY workspace requires it (strictest wins)
   * Owners only can edit.
   */
  security_policy?: WorkspaceSecurityPolicy | null;
}

export interface WorkspaceSecurityPolicy {
  /** Maximum session lifetime in minutes. Null means no cap (default 30d). */
  session_max_age_minutes: number | null;
  /** Every member must have TOTP enrolled and have passed the MFA challenge. */
  require_mfa: boolean;
  /**
   * Outbound webhook SSRF policy. When false (default) the dispatcher refuses
   * to POST to loopback, link-local, RFC1918, multicast, broadcast, or the
   * AWS/GCP/Azure metadata IPs. Set true only for closed networks where you
   * legitimately need to call private hosts (self-hosted webhook sinks).
   */
  webhook_allow_private_networks: boolean;
  /**
   * Optional explicit host allowlist for outbound webhooks. When set (non-empty),
   * destination hostnames must match one of these entries exactly or as a
   * suffix after a leading dot (e.g. ".acme.com" matches "hooks.acme.com").
   * Empty array means "no host restriction beyond the SSRF guard".
   */
  webhook_host_allowlist: string[];
  updated_at: number;
  updated_by: string;
}

export const POLICY_MIN_SESSION_MINUTES = 5;
export const POLICY_MAX_SESSION_MINUTES = 30 * 24 * 60; // 30 days

export type SsoProvider = "oidc";

export interface WorkspaceSso {
  provider: SsoProvider;
  /** Display label shown on the login button, e.g. "Acme Okta". */
  label: string;
  /** OIDC issuer URL, e.g. https://login.example.com or https://accounts.google.com. */
  issuer: string;
  client_id: string;
  client_secret: string;
  /** Lower-cased email domains that route to this IdP, e.g. ["acme.com"]. */
  allowed_email_domains: string[];
  /** If true, those email domains MUST use SSO; magic link / GitHub are blocked. */
  enforce: boolean;
  updated_at: number;
  updated_by: string;
}

export interface PublicWorkspaceSso {
  provider: SsoProvider;
  label: string;
  issuer: string;
  client_id: string;
  allowed_email_domains: string[];
  enforce: boolean;
  updated_at: number;
  /** Secret never leaves the server. */
  has_client_secret: boolean;
}

export interface Member {
  workspace_id: string;
  user_id: string;
  email: string;
  role: Role;
  joined_at: number;
}

export interface Invite {
  id: string;
  workspace_id: string;
  email: string; // lowercased
  role: Role;
  token_hash: string;
  invited_by: string; // user id
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
}

interface Store {
  version: 1;
  workspaces: Workspace[];
  members: Member[];
  invites: Invite[];
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = () => path.join(
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data"),
  "workspaces.json",
);

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function ensureDir() {
  const dir = process.env.ADHERENCE_DATA_DIR ?? DATA_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  const p = STORE_PATH();
  if (!existsSync(p)) {
    return { version: 1, workspaces: [], members: [], invites: [] };
  }
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1) {
      return { version: 1, workspaces: [], members: [], invites: [] };
    }
    parsed.workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    parsed.members = Array.isArray(parsed.members) ? parsed.members : [];
    parsed.invites = Array.isArray(parsed.invites) ? parsed.invites : [];
    return parsed;
  } catch {
    return { version: 1, workspaces: [], members: [], invites: [] };
  }
}

async function writeStore(store: Store): Promise<void> {
  ensureDir();
  const body = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(STORE_PATH(), body, "utf8"));
  return writeQueue;
}

function newId(prefix: string): string {
  return prefix + "_" + randomBytes(8).toString("base64url").slice(0, 12);
}

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as string[]).includes(x);
}

/**
 * Returns every workspace the user belongs to, ensuring at least one
 * personal workspace exists (auto-created on first call).
 */
export async function listForUser(
  userId: string,
  email: string,
): Promise<Array<Workspace & { role: Role }>> {
  const store = await readStore();
  let mine = store.members.filter((m) => m.user_id === userId);
  if (mine.length === 0) {
    const ws: Workspace = {
      id: newId("ws"),
      name: email.split("@")[0] + "'s workspace",
      created_at: Date.now(),
      created_by: userId,
    };
    const mem: Member = {
      workspace_id: ws.id,
      user_id: userId,
      email,
      role: "owner",
      joined_at: Date.now(),
    };
    store.workspaces.push(ws);
    store.members.push(mem);
    await writeStore(store);
    mine = [mem];
  }
  return mine
    .map((m) => {
      const ws = store.workspaces.find((w) => w.id === m.workspace_id);
      return ws ? { ...ws, role: m.role } : null;
    })
    .filter((x): x is Workspace & { role: Role } => x !== null);
}

export async function createWorkspace(
  userId: string,
  email: string,
  name: string,
): Promise<Workspace> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");
  const store = await readStore();
  const ws: Workspace = {
    id: newId("ws"),
    name: trimmed.slice(0, 80),
    created_at: Date.now(),
    created_by: userId,
  };
  store.workspaces.push(ws);
  store.members.push({
    workspace_id: ws.id,
    user_id: userId,
    email,
    role: "owner",
    joined_at: Date.now(),
  });
  await writeStore(store);
  return ws;
}

export async function getWorkspaceForUser(
  workspaceId: string,
  userId: string,
): Promise<{ workspace: Workspace; role: Role; members: Member[] } | null> {
  const store = await readStore();
  const mem = store.members.find(
    (m) => m.workspace_id === workspaceId && m.user_id === userId,
  );
  if (!mem) return null;
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  const members = store.members.filter((m) => m.workspace_id === workspaceId);
  return { workspace: ws, role: mem.role, members };
}

export async function listInvites(
  workspaceId: string,
): Promise<Invite[]> {
  const store = await readStore();
  return store.invites
    .filter((i) => i.workspace_id === workspaceId)
    .sort((a, b) => b.created_at - a.created_at);
}

/**
 * Create an invite. Returns the plaintext token (the only time it appears
 * unhashed) plus the persisted record. Caller embeds the token in the
 * /invite/<token> URL it surfaces to the inviter.
 */
export async function createInvite(
  workspaceId: string,
  invitedBy: string,
  email: string,
  role: Role,
): Promise<{ token: string; invite: Invite }> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("invalid email");
  if (!isRole(role)) throw new Error("invalid role");
  const store = await readStore();
  // garbage-collect expired
  const now = Date.now();
  store.invites = store.invites.filter(
    (i) => i.accepted_at !== null || i.revoked_at !== null || i.expires_at > now,
  );
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("workspace not found");
  // skip duplicate pending invite for the same email
  const dup = store.invites.find(
    (i) =>
      i.workspace_id === workspaceId &&
      i.email === e &&
      i.accepted_at === null &&
      i.revoked_at === null &&
      i.expires_at > now,
  );
  if (dup) throw new Error("invite already pending");

  const plaintext = randomBytes(24).toString("base64url");
  const invite: Invite = {
    id: newId("inv"),
    workspace_id: workspaceId,
    email: e,
    role,
    token_hash: hashToken(plaintext),
    invited_by: invitedBy,
    created_at: now,
    expires_at: now + INVITE_TTL_MS,
    accepted_at: null,
    revoked_at: null,
  };
  store.invites.push(invite);
  await writeStore(store);
  return { token: plaintext, invite };
}

export async function revokeInvite(
  workspaceId: string,
  inviteId: string,
): Promise<boolean> {
  const store = await readStore();
  const inv = store.invites.find(
    (i) => i.id === inviteId && i.workspace_id === workspaceId,
  );
  if (!inv) return false;
  if (inv.accepted_at || inv.revoked_at) return false;
  inv.revoked_at = Date.now();
  await writeStore(store);
  return true;
}

/**
 * Lookup an invite by plaintext token (does not consume).
 */
export async function previewInvite(
  plaintext: string,
): Promise<{ invite: Invite; workspace: Workspace } | null> {
  if (!plaintext) return null;
  const h = hashToken(plaintext);
  const store = await readStore();
  const inv = store.invites.find((i) => i.token_hash === h);
  if (!inv) return null;
  if (inv.accepted_at || inv.revoked_at) return null;
  if (inv.expires_at < Date.now()) return null;
  const ws = store.workspaces.find((w) => w.id === inv.workspace_id);
  if (!ws) return null;
  return { invite: inv, workspace: ws };
}

/**
 * Accept an invite for the given user. Idempotent: if the user is already a
 * member, the invite is still marked accepted and the existing membership is
 * returned.
 */
export async function acceptInvite(
  plaintext: string,
  userId: string,
  email: string,
): Promise<{ workspace: Workspace; role: Role } | null> {
  const h = hashToken(plaintext);
  const store = await readStore();
  const inv = store.invites.find((i) => i.token_hash === h);
  if (!inv) return null;
  if (inv.accepted_at || inv.revoked_at) return null;
  if (inv.expires_at < Date.now()) return null;
  const ws = store.workspaces.find((w) => w.id === inv.workspace_id);
  if (!ws) return null;

  // The invite is bound to an email. Allow accept if the session email
  // matches, OR if the inviter sent to a different address (we still attach
  // the current user, but only when emails match exactly to prevent
  // hijacking via leaked links).
  if (inv.email !== email.toLowerCase()) return null;

  inv.accepted_at = Date.now();
  let mem = store.members.find(
    (m) => m.workspace_id === ws.id && m.user_id === userId,
  );
  if (!mem) {
    mem = {
      workspace_id: ws.id,
      user_id: userId,
      email: email.toLowerCase(),
      role: inv.role,
      joined_at: Date.now(),
    };
    store.members.push(mem);
  }
  await writeStore(store);
  return { workspace: ws, role: mem.role };
}

/**
 * Owner-only: replace the SSO config for a workspace. Pass null to clear.
 * Returns the new public (secret-stripped) config or null when removed.
 */
export async function setWorkspaceSso(
  workspaceId: string,
  actorUserId: string,
  next: Omit<WorkspaceSso, "updated_at" | "updated_by"> | null,
): Promise<PublicWorkspaceSso | null> {
  const store = await readStore();
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("workspace not found");
  const me = store.members.find(
    (m) => m.workspace_id === workspaceId && m.user_id === actorUserId,
  );
  if (!me || me.role !== "owner") throw new Error("owner only");
  if (next === null) {
    ws.sso = null;
    await writeStore(store);
    return null;
  }
  if (next.provider !== "oidc") throw new Error("unsupported provider");
  const label = (next.label ?? "").trim().slice(0, 80);
  const issuer = (next.issuer ?? "").trim();
  if (!/^https:\/\/[^\s]+$/i.test(issuer)) throw new Error("issuer must be an https URL");
  const client_id = (next.client_id ?? "").trim();
  const client_secret = (next.client_secret ?? "").trim();
  if (!label) throw new Error("label required");
  if (!client_id) throw new Error("client_id required");
  if (!client_secret) throw new Error("client_secret required");
  const domains = Array.from(
    new Set(
      (next.allowed_email_domains ?? [])
        .map((d) => String(d ?? "").trim().toLowerCase())
        .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)),
    ),
  );
  if (next.enforce && domains.length === 0) {
    throw new Error("at least one allowed_email_domain is required to enforce SSO");
  }
  ws.sso = {
    provider: "oidc",
    label,
    issuer: issuer.replace(/\/+$/, ""),
    client_id,
    client_secret,
    allowed_email_domains: domains,
    enforce: Boolean(next.enforce),
    updated_at: Date.now(),
    updated_by: actorUserId,
  };
  await writeStore(store);
  return publicSso(ws.sso);
}

export function publicSso(s: WorkspaceSso | null | undefined): PublicWorkspaceSso | null {
  if (!s) return null;
  return {
    provider: s.provider,
    label: s.label,
    issuer: s.issuer,
    client_id: s.client_id,
    allowed_email_domains: s.allowed_email_domains,
    enforce: s.enforce,
    updated_at: s.updated_at,
    has_client_secret: Boolean(s.client_secret),
  };
}

export async function getWorkspaceSso(
  workspaceId: string,
): Promise<WorkspaceSso | null> {
  const store = await readStore();
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  return ws?.sso ?? null;
}

/**
 * Look up a workspace whose SSO config claims the given email domain. If
 * multiple workspaces claim it, the most-recently-updated one wins. Used
 * by the login routes to decide whether magic link / GitHub should be
 * blocked, and where to start the SSO redirect from.
 */
export async function findSsoForEmail(
  email: string,
): Promise<{ workspace: Workspace; sso: WorkspaceSso } | null> {
  const at = email.indexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) return null;
  const store = await readStore();
  const matches = store.workspaces
    .filter((w) => w.sso && w.sso.allowed_email_domains.includes(domain))
    .sort((a, b) => (b.sso!.updated_at ?? 0) - (a.sso!.updated_at ?? 0));
  if (matches.length === 0) return null;
  return { workspace: matches[0], sso: matches[0].sso! };
}

export async function removeMember(
  workspaceId: string,
  actingUserId: string,
  targetUserId: string,
): Promise<boolean> {
  const store = await readStore();
  const acting = store.members.find(
    (m) => m.workspace_id === workspaceId && m.user_id === actingUserId,
  );
  if (!acting || acting.role !== "owner") return false;
  if (actingUserId === targetUserId) {
    // refuse to remove the last owner
    const owners = store.members.filter(
      (m) => m.workspace_id === workspaceId && m.role === "owner",
    );
    if (owners.length <= 1) return false;
  }
  const before = store.members.length;
  store.members = store.members.filter(
    (m) => !(m.workspace_id === workspaceId && m.user_id === targetUserId),
  );
  if (store.members.length === before) return false;
  await writeStore(store);
  return true;
}

/**
 * Plan what would happen if `userId` were erased from the system.
 * For each workspace the user belongs to we report either:
 *   - `leave`: the user is one of several members; their row is removed.
 *   - `delete_workspace`: the user is the sole owner AND no other member
 *     exists, so the entire workspace is purged.
 *   - `blocked`: the user is the sole owner but other members would be
 *     orphaned. The caller MUST refuse erasure (or transfer ownership)
 *     in this case.
 *
 * Pure read; does not mutate state.
 */
export interface MembershipImpact {
  workspace_id: string;
  workspace_name: string;
  role: Role;
  action: "leave" | "delete_workspace" | "blocked";
  reason?: string;
  other_member_count: number;
}

export async function planUserErasure(
  userId: string,
): Promise<MembershipImpact[]> {
  const store = await readStore();
  const mine = store.members.filter((m) => m.user_id === userId);
  return mine.map((m) => {
    const ws = store.workspaces.find((w) => w.id === m.workspace_id);
    const wsName = ws?.name ?? "(unknown)";
    const others = store.members.filter(
      (x) => x.workspace_id === m.workspace_id && x.user_id !== userId,
    );
    if (m.role !== "owner") {
      return {
        workspace_id: m.workspace_id,
        workspace_name: wsName,
        role: m.role,
        action: "leave" as const,
        other_member_count: others.length,
      };
    }
    // role === owner
    if (others.length === 0) {
      return {
        workspace_id: m.workspace_id,
        workspace_name: wsName,
        role: m.role,
        action: "delete_workspace" as const,
        other_member_count: 0,
      };
    }
    const otherOwners = others.filter((x) => x.role === "owner");
    if (otherOwners.length === 0) {
      return {
        workspace_id: m.workspace_id,
        workspace_name: wsName,
        role: m.role,
        action: "blocked" as const,
        reason:
          "you are the sole owner of this shared workspace; transfer ownership before deleting your account",
        other_member_count: others.length,
      };
    }
    return {
      workspace_id: m.workspace_id,
      workspace_name: wsName,
      role: m.role,
      action: "leave" as const,
      other_member_count: others.length,
    };
  });
}

export interface ErasureReport {
  memberships_removed: number;
  workspaces_deleted: string[];
  invites_revoked: number;
}

/**
 * Execute the erasure plan. Throws if any workspace would be left orphaned
 * (sole owner with other members). Caller MUST first call planUserErasure
 * and surface the blocked entries to the user.
 */
export async function eraseUserFromWorkspaces(
  userId: string,
): Promise<ErasureReport> {
  const store = await readStore();
  const mine = store.members.filter((m) => m.user_id === userId);
  const wsToDelete: string[] = [];
  for (const m of mine) {
    if (m.role !== "owner") continue;
    const others = store.members.filter(
      (x) => x.workspace_id === m.workspace_id && x.user_id !== userId,
    );
    if (others.length === 0) {
      wsToDelete.push(m.workspace_id);
      continue;
    }
    const otherOwners = others.filter((x) => x.role === "owner");
    if (otherOwners.length === 0) {
      throw new Error(
        `cannot erase: sole owner of workspace ${m.workspace_id} with ${others.length} other member(s)`,
      );
    }
  }

  const memBefore = store.members.length;
  store.members = store.members.filter((m) => m.user_id !== userId);
  const memRemoved = memBefore - store.members.length;

  const wsSet = new Set(wsToDelete);
  store.workspaces = store.workspaces.filter((w) => !wsSet.has(w.id));
  // sweep any stragglers in those workspaces just in case
  store.members = store.members.filter((m) => !wsSet.has(m.workspace_id));

  // revoke invites the user issued OR invites pointing at their email
  const user = await (async () => {
    const { getUserById } = await import("./users-store");
    return getUserById(userId);
  })();
  const email = user?.email ?? null;
  let invitesRevoked = 0;
  const now = Date.now();
  for (const inv of store.invites) {
    if (inv.revoked_at || inv.accepted_at) continue;
    if (inv.invited_by === userId || (email && inv.email === email)) {
      inv.revoked_at = now;
      invitesRevoked += 1;
    }
  }

  await writeStore(store);
  return {
    memberships_removed: memRemoved,
    workspaces_deleted: wsToDelete,
    invites_revoked: invitesRevoked,
  };
}

export async function _resetForTests(): Promise<void> {
  await writeStore({ version: 1, workspaces: [], members: [], invites: [] });
}

// ---------------------------------------------------------------------------
// SCIM-driven provisioning. These helpers are called by /scim/v2/* after the
// caller has presented a valid workspace-scoped bearer token. They are
// strictly scoped to one `workspaceId` so a token for workspace A can never
// touch workspace B.
// ---------------------------------------------------------------------------

export interface ProvisionedMember {
  user_id: string;
  email: string;
  role: Role;
  workspace_id: string;
  created: boolean; // true if the user record was created by this call
  joined: boolean;  // true if the member row was created by this call
}

/**
 * Create or update a member of `workspaceId`. If a user with this email
 * doesn't exist yet, one is created. If the user is already a member, only
 * the role is updated (when changed). Caller has already verified workspace
 * authorisation.
 */
export async function provisionMember(
  workspaceId: string,
  email: string,
  role: Role,
): Promise<ProvisionedMember> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("invalid email");
  if (!isRole(role)) throw new Error("invalid role");
  const store = await readStore();
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("workspace not found");

  const { getOrCreateUserByEmail } = await import("./users-store");
  const userCountBefore = (await import("./users-store")).getUserById; // tree-shake guard
  void userCountBefore;
  const user = await getOrCreateUserByEmail(e);
  const userWasNew = user.created_at === user.last_login_at;

  // Re-read after user creation so we don't clobber a concurrent write.
  const s2 = await readStore();
  const existing = s2.members.find(
    (m) => m.workspace_id === workspaceId && m.user_id === user.id,
  );
  let joined = false;
  if (!existing) {
    s2.members.push({
      workspace_id: workspaceId,
      user_id: user.id,
      email: e,
      role,
      joined_at: Date.now(),
    });
    joined = true;
  } else if (existing.role !== role) {
    // Never demote the last owner via SCIM; the IdP must not be able to
    // strand a workspace.
    if (existing.role === "owner" && role !== "owner") {
      const owners = s2.members.filter(
        (m) => m.workspace_id === workspaceId && m.role === "owner",
      );
      if (owners.length <= 1) {
        throw new Error("cannot demote the last owner");
      }
    }
    existing.role = role;
  }
  await writeStore(s2);
  return {
    user_id: user.id,
    email: e,
    role,
    workspace_id: workspaceId,
    created: userWasNew,
    joined,
  };
}

/**
 * Look up a member by user id within a workspace. SCIM `Users/{id}` reads
 * use this; returns null on cross-tenant lookups, which is what makes the
 * isolation property true.
 */
export async function findMember(
  workspaceId: string,
  userId: string,
): Promise<Member | null> {
  const s = await readStore();
  const m = s.members.find(
    (x) => x.workspace_id === workspaceId && x.user_id === userId,
  );
  return m ?? null;
}

export async function listMembers(
  workspaceId: string,
): Promise<Member[]> {
  const s = await readStore();
  return s.members
    .filter((m) => m.workspace_id === workspaceId)
    .sort((a, b) => a.joined_at - b.joined_at);
}

/**
 * Owner-driven role update via the dashboard UI / public API. Verifies:
 *   - acting user is an owner of `workspaceId`
 *   - target member exists in this workspace (no cross-tenant writes)
 *   - last owner is never demoted (workspace cannot be stranded)
 *
 * Returns the updated Member, or a string error code:
 *   - 'forbidden'        acting user is not an owner of this workspace
 *   - 'not_found'        target user is not a member of this workspace
 *   - 'invalid_role'     role is not one of ROLES
 *   - 'last_owner'       refuses to demote the only remaining owner
 */
export async function changeMemberRoleByOwner(
  workspaceId: string,
  actingUserId: string,
  targetUserId: string,
  role: Role,
): Promise<Member | "forbidden" | "not_found" | "invalid_role" | "last_owner"> {
  if (!isRole(role)) return "invalid_role";
  const store = await readStore();
  const acting = store.members.find(
    (m) => m.workspace_id === workspaceId && m.user_id === actingUserId,
  );
  if (!acting || acting.role !== "owner") return "forbidden";
  const target = store.members.find(
    (m) => m.workspace_id === workspaceId && m.user_id === targetUserId,
  );
  if (!target) return "not_found";
  if (target.role === role) return target;
  if (target.role === "owner" && role !== "owner") {
    const owners = store.members.filter(
      (m) => m.workspace_id === workspaceId && m.role === "owner",
    );
    if (owners.length <= 1) return "last_owner";
  }
  target.role = role;
  await writeStore(store);
  return target;
}

/**
 * SCIM-driven role update. Same safety: refuses to demote the last owner.
 */
export async function setMemberRole(
  workspaceId: string,
  userId: string,
  role: Role,
): Promise<Member | null> {
  if (!isRole(role)) throw new Error("invalid role");
  const s = await readStore();
  const m = s.members.find(
    (x) => x.workspace_id === workspaceId && x.user_id === userId,
  );
  if (!m) return null;
  if (m.role === role) return m;
  if (m.role === "owner" && role !== "owner") {
    const owners = s.members.filter(
      (x) => x.workspace_id === workspaceId && x.role === "owner",
    );
    if (owners.length <= 1) throw new Error("cannot demote the last owner");
  }
  m.role = role;
  await writeStore(s);
  return m;
}

/**
 * SCIM-driven deprovisioning. Refuses to remove the last owner. Returns
 * false when no such member exists in the given workspace (so a token for
 * workspace A trying to delete a user in workspace B is a no-op, not an
 * accidental cross-tenant write).
 */
export async function deprovisionMember(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const s = await readStore();
  const m = s.members.find(
    (x) => x.workspace_id === workspaceId && x.user_id === userId,
  );
  if (!m) return false;
  if (m.role === "owner") {
    const owners = s.members.filter(
      (x) => x.workspace_id === workspaceId && x.role === "owner",
    );
    if (owners.length <= 1) throw new Error("cannot remove the last owner");
  }
  const before = s.members.length;
  s.members = s.members.filter(
    (x) => !(x.workspace_id === workspaceId && x.user_id === userId),
  );
  if (s.members.length === before) return false;
  await writeStore(s);
  return true;
}


// ---------------------------------------------------------------------------
// Workspace security policy (session TTL cap, MFA requirement)
// ---------------------------------------------------------------------------

export interface PublicWorkspaceSecurityPolicy {
  session_max_age_minutes: number | null;
  require_mfa: boolean;
  webhook_allow_private_networks: boolean;
  webhook_host_allowlist: string[];
  updated_at: number;
}

export function publicPolicy(
  p: WorkspaceSecurityPolicy | null | undefined,
): PublicWorkspaceSecurityPolicy {
  if (!p) {
    return {
      session_max_age_minutes: null,
      require_mfa: false,
      webhook_allow_private_networks: false,
      webhook_host_allowlist: [],
      updated_at: 0,
    };
  }
  return {
    session_max_age_minutes: p.session_max_age_minutes,
    require_mfa: p.require_mfa,
    webhook_allow_private_networks: Boolean(p.webhook_allow_private_networks),
    webhook_host_allowlist: Array.isArray(p.webhook_host_allowlist)
      ? [...p.webhook_host_allowlist]
      : [],
    updated_at: p.updated_at,
  };
}

export async function getWorkspacePolicy(
  workspaceId: string,
): Promise<WorkspaceSecurityPolicy | null> {
  const store = await readStore();
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  return ws?.security_policy ?? null;
}

export async function setWorkspacePolicy(
  workspaceId: string,
  actorUserId: string,
  next: {
    session_max_age_minutes: number | null;
    require_mfa: boolean;
    webhook_allow_private_networks?: boolean;
    webhook_host_allowlist?: string[];
  },
): Promise<PublicWorkspaceSecurityPolicy> {
  const store = await readStore();
  const ws = store.workspaces.find((w) => w.id === workspaceId);
  if (!ws) throw new Error("workspace not found");
  const me = store.members.find(
    (m) => m.workspace_id === workspaceId && m.user_id === actorUserId,
  );
  if (!me || me.role !== "owner") throw new Error("owner only");
  let cap: number | null = null;
  if (next.session_max_age_minutes !== null && next.session_max_age_minutes !== undefined) {
    const n = Math.floor(Number(next.session_max_age_minutes));
    if (!Number.isFinite(n) || n < POLICY_MIN_SESSION_MINUTES || n > POLICY_MAX_SESSION_MINUTES) {
      throw new Error(
        `session_max_age_minutes must be between ${POLICY_MIN_SESSION_MINUTES} and ${POLICY_MAX_SESSION_MINUTES}`,
      );
    }
    cap = n;
  }
  // Normalize host allowlist: trim, lowercase, dedupe, drop empties, cap entries.
  const rawAllow = Array.isArray(next.webhook_host_allowlist)
    ? next.webhook_host_allowlist
    : Array.isArray(ws.security_policy?.webhook_host_allowlist)
      ? ws.security_policy!.webhook_host_allowlist
      : [];
  const hostAllowlist = Array.from(
    new Set(
      rawAllow
        .map((h) => String(h).trim().toLowerCase())
        .filter((h) => h.length > 0 && h.length <= 253),
    ),
  ).slice(0, 64);
  const allowPrivate =
    typeof next.webhook_allow_private_networks === "boolean"
      ? next.webhook_allow_private_networks
      : Boolean(ws.security_policy?.webhook_allow_private_networks);
  ws.security_policy = {
    session_max_age_minutes: cap,
    require_mfa: Boolean(next.require_mfa),
    webhook_allow_private_networks: allowPrivate,
    webhook_host_allowlist: hostAllowlist,
    updated_at: Date.now(),
    updated_by: actorUserId,
  };
  await writeStore(store);
  return publicPolicy(ws.security_policy);
}

/**
 * Effective security policy for a user, computed across every workspace they
 * belong to. Tightest rule wins:
 *   - session_max_age_minutes: minimum across workspaces (null = unset)
 *   - require_mfa: true if any workspace requires it
 */
export async function effectivePolicyForUser(
  userId: string,
): Promise<{ session_max_age_minutes: number | null; require_mfa: boolean; sources: string[] }> {
  const store = await readStore();
  const myWorkspaceIds = store.members
    .filter((m) => m.user_id === userId)
    .map((m) => m.workspace_id);
  let cap: number | null = null;
  let mfa = false;
  const sources: string[] = [];
  for (const ws of store.workspaces) {
    if (!myWorkspaceIds.includes(ws.id)) continue;
    const p = ws.security_policy;
    if (!p) continue;
    if (p.session_max_age_minutes !== null) {
      if (cap === null || p.session_max_age_minutes < cap) {
        cap = p.session_max_age_minutes;
      }
      sources.push(ws.id);
    }
    if (p.require_mfa) {
      mfa = true;
      if (!sources.includes(ws.id)) sources.push(ws.id);
    }
  }
  return { session_max_age_minutes: cap, require_mfa: mfa, sources };
}


// ---------------------------------------------------------------------------
// Outbound webhook SSRF policy (global across workspaces)
// ---------------------------------------------------------------------------

/**
 * Effective SSRF policy for outbound webhooks. Webhook endpoints are not
 * workspace-scoped today (single shared store), so we collapse every
 * workspace's policy into the strictest setting:
 *
 *   - allow_private_networks: true ONLY if every workspace with a non-default
 *     policy has opted in. Default workspaces are treated as deny.
 *   - host_allowlist: union of every workspace's non-empty allowlist. If at
 *     least one workspace has set an allowlist, deliveries are gated by it.
 *     If no workspace has set one, no host filter is applied.
 */
export async function effectiveWebhookSsrfPolicy(): Promise<{
  allow_private_networks: boolean;
  host_allowlist: string[];
  sources: string[];
}> {
  // Env escape for self-hosted single-tenant deployments and the test
  // harness. When set, private destinations are permitted; the metadata-IP
  // block in webhook-ssrf.ts still applies and cannot be turned off.
  const envAllow =
    process.env.ADHERENCE_WEBHOOK_ALLOW_PRIVATE === "1" ||
    process.env.ADHERENCE_WEBHOOK_ALLOW_PRIVATE === "true";
  const store = await readStore();
  if (!store.workspaces.length) {
    return {
      allow_private_networks: envAllow,
      host_allowlist: [],
      sources: [],
    };
  }
  let allow = true;
  const allowlist = new Set<string>();
  const sources: string[] = [];
  let opinionated = 0;
  for (const ws of store.workspaces) {
    const p = ws.security_policy;
    if (!p) {
      // Unconfigured workspaces inherit the safe default (deny private).
      allow = false;
      continue;
    }
    opinionated++;
    sources.push(ws.id);
    if (!p.webhook_allow_private_networks) allow = false;
    for (const h of p.webhook_host_allowlist ?? []) {
      const t = String(h).trim().toLowerCase();
      if (t) allowlist.add(t);
    }
  }
  // If nobody set an opinion, fall back to safe defaults.
  if (opinionated === 0) allow = false;
  return {
    allow_private_networks: envAllow || allow,
    host_allowlist: [...allowlist],
    sources,
  };
}
