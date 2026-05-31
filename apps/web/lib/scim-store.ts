/**
 * SCIM 2.0 bearer-token store (RFC 7644).
 *
 * Each token is scoped to exactly one workspace. The plaintext token is
 * returned to the workspace owner exactly once at creation; only a sha256
 * hash and a short prefix are persisted, so a leaked store file leaks no
 * usable credentials. Identity providers (Okta, Azure AD, Google Workspace,
 * OneLogin, JumpCloud) use these tokens to drive user provisioning via the
 * /scim/v2/* endpoints.
 *
 * Storage: ADHERENCE_DATA_DIR/scim-tokens.json. File-backed JSON to match
 * the rest of the dashboard so it deploys with zero infra.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export interface ScimTokenRecord {
  id: string;
  workspace_id: string;
  name: string;
  prefix: string; // first 10 chars of plaintext for display
  hash: string; // sha256(plaintext)
  created_at: number;
  created_by: string;
  last_used_at: number | null;
  last_used_ip: string | null;
  use_count: number;
  revoked_at: number | null;
}

export interface PublicScimToken {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
  last_used_ip: string | null;
  use_count: number;
  revoked_at: number | null;
}

interface Store {
  version: 1;
  tokens: ScimTokenRecord[];
}

const DATA_DIR = () =>
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = () => path.join(DATA_DIR(), "scim-tokens.json");

function ensureDir() {
  const d = DATA_DIR();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  const p = STORE_PATH();
  if (!existsSync(p)) return { version: 1, tokens: [] };
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1) return { version: 1, tokens: [] };
    parsed.tokens = Array.isArray(parsed.tokens) ? parsed.tokens : [];
    return parsed;
  } catch {
    return { version: 1, tokens: [] };
  }
}

async function writeStore(s: Store): Promise<void> {
  ensureDir();
  const body = JSON.stringify(s, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(STORE_PATH(), body, "utf8"));
  return writeQueue;
}

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function newId(): string {
  return "scim_" + randomBytes(8).toString("base64url").slice(0, 12);
}

export function publicView(t: ScimTokenRecord): PublicScimToken {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    created_at: t.created_at,
    created_by: t.created_by,
    last_used_at: t.last_used_at,
    last_used_ip: t.last_used_ip,
    use_count: t.use_count,
    revoked_at: t.revoked_at,
  };
}

export async function listForWorkspace(
  workspaceId: string,
): Promise<PublicScimToken[]> {
  const s = await readStore();
  return s.tokens
    .filter((t) => t.workspace_id === workspaceId)
    .sort((a, b) => b.created_at - a.created_at)
    .map(publicView);
}

export async function createToken(
  workspaceId: string,
  createdBy: string,
  name: string,
): Promise<{ plaintext: string; token: PublicScimToken }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");
  // Long, url-safe: 32 bytes -> 43 chars.
  const plaintext = "scim_v2_" + randomBytes(32).toString("base64url");
  const rec: ScimTokenRecord = {
    id: newId(),
    workspace_id: workspaceId,
    name: trimmed.slice(0, 80),
    prefix: plaintext.slice(0, 10),
    hash: hashToken(plaintext),
    created_at: Date.now(),
    created_by: createdBy,
    last_used_at: null,
    last_used_ip: null,
    use_count: 0,
    revoked_at: null,
  };
  const s = await readStore();
  s.tokens.push(rec);
  await writeStore(s);
  return { plaintext, token: publicView(rec) };
}

export async function revokeToken(
  workspaceId: string,
  tokenId: string,
): Promise<boolean> {
  const s = await readStore();
  const t = s.tokens.find(
    (x) => x.id === tokenId && x.workspace_id === workspaceId,
  );
  if (!t) return false;
  if (t.revoked_at) return false;
  t.revoked_at = Date.now();
  await writeStore(s);
  return true;
}

/**
 * Validate a presented bearer token and return the workspace it grants
 * access to. Returns null for unknown, revoked, or malformed tokens. Uses
 * timing-safe comparison.
 */
export async function verifyToken(
  plaintext: string,
  ip: string | null,
): Promise<{ workspaceId: string; tokenId: string } | null> {
  if (!plaintext || typeof plaintext !== "string") return null;
  // SCIM clients commonly send "Bearer <token>"; caller strips the prefix
  // but be defensive against stray whitespace.
  const stripped = plaintext.trim();
  if (!stripped) return null;
  const candidateHash = Buffer.from(hashToken(stripped), "hex");
  const s = await readStore();
  for (const t of s.tokens) {
    if (t.revoked_at) continue;
    const knownHash = Buffer.from(t.hash, "hex");
    if (knownHash.length !== candidateHash.length) continue;
    if (!timingSafeEqual(knownHash, candidateHash)) continue;
    t.last_used_at = Date.now();
    t.last_used_ip = ip;
    t.use_count += 1;
    await writeStore(s);
    return { workspaceId: t.workspace_id, tokenId: t.id };
  }
  return null;
}

export async function _resetForTests(): Promise<void> {
  await writeStore({ version: 1, tokens: [] });
}
