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

export async function _resetForTests(): Promise<void> {
  await writeStore({ version: 1, workspaces: [], members: [], invites: [] });
}

// ---------------------------------------------------------------------------
// Workspace security policy (session TTL cap, MFA requirement)
// ---------------------------------------------------------------------------

export interface PublicWorkspaceSecurityPolicy {
  session_max_age_minutes: number | null;
  require_mfa: boolean;
  updated_at: number;
}

export function publicPolicy(
  p: WorkspaceSecurityPolicy | null | undefined,
): PublicWorkspaceSecurityPolicy {
  if (!p) {
    return { session_max_age_minutes: null, require_mfa: false, updated_at: 0 };
  }
  return {
    session_max_age_minutes: p.session_max_age_minutes,
    require_mfa: p.require_mfa,
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
  next: { session_max_age_minutes: number | null; require_mfa: boolean },
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
  ws.security_policy = {
    session_max_age_minutes: cap,
    require_mfa: Boolean(next.require_mfa),
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

