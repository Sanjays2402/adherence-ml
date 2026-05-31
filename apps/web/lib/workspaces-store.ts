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
