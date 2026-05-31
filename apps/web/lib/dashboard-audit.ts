/**
 * Dashboard audit log.
 *
 * Append-only JSONL with a SHA-256 hash chain (each entry includes the hash
 * of the previous entry) so tampering is detectable. Independent of the
 * /v1/audit prediction log (that one lives in the FastAPI service); this one
 * captures dashboard-side mutations the buyer's security team will ask about:
 * data export, account wipe, settings changes, etc.
 *
 * Storage: ADHERENCE_DATA_DIR/dashboard-audit.jsonl.
 * Reads tail (most recent first). Writes serialised through an in-process
 * queue to keep the chain monotonic.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditEntry {
  id: string;
  ts: number;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  outcome: AuditOutcome;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
  prev_hash: string;
  hash: string;
}

const DATA_DIR = () =>
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const LOG_PATH = () => path.join(DATA_DIR(), "dashboard-audit.jsonl");

function ensureDir() {
  const d = DATA_DIR();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();
let cachedTail: AuditEntry | null | undefined = undefined;

const GENESIS_HASH = "0".repeat(64);

function hashEntry(e: Omit<AuditEntry, "hash">): string {
  const canonical = JSON.stringify([
    e.id,
    e.ts,
    e.actor_user_id,
    e.actor_email,
    e.action,
    e.target,
    e.outcome,
    e.ip,
    e.user_agent,
    e.metadata,
    e.prev_hash,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

async function readTail(): Promise<AuditEntry | null> {
  if (cachedTail !== undefined) return cachedTail;
  ensureDir();
  const p = LOG_PATH();
  if (!existsSync(p)) {
    cachedTail = null;
    return null;
  }
  const raw = await fs.readFile(p, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    cachedTail = null;
    return null;
  }
  try {
    cachedTail = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
  } catch {
    cachedTail = null;
  }
  return cachedTail;
}

export interface RecordOptions {
  action: string;
  target?: string | null;
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown> | null;
  actor?: { user_id: string | null; email: string | null } | null;
  request?: NextRequest | null;
}

function extractIp(req?: NextRequest | null): string | null {
  if (!req) return null;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return null;
}

export async function recordAudit(opts: RecordOptions): Promise<AuditEntry> {
  const entry: Omit<AuditEntry, "hash"> = {
    id: randomBytes(8).toString("hex"),
    ts: Date.now(),
    actor_user_id: opts.actor?.user_id ?? null,
    actor_email: opts.actor?.email ?? null,
    action: opts.action,
    target: opts.target ?? null,
    outcome: opts.outcome ?? "success",
    ip: extractIp(opts.request),
    user_agent: opts.request?.headers.get("user-agent") ?? null,
    metadata: opts.metadata ?? null,
    prev_hash: GENESIS_HASH,
  };

  let resolved!: (v: AuditEntry) => void;
  let rejected!: (e: unknown) => void;
  const wait = new Promise<AuditEntry>((res, rej) => {
    resolved = res;
    rejected = rej;
  });
  writeQueue = writeQueue.then(async () => {
    try {
      ensureDir();
      const tail = await readTail();
      entry.prev_hash = tail ? tail.hash : GENESIS_HASH;
      const full: AuditEntry = { ...entry, hash: hashEntry(entry) };
      await fs.appendFile(LOG_PATH(), JSON.stringify(full) + "\n", "utf8");
      cachedTail = full;
      resolved(full);
    } catch (e) {
      rejected(e);
    }
  });
  return wait;
}

export interface ListOptions {
  limit?: number;
  action?: string;
  actor_user_id?: string;
  outcome?: AuditOutcome;
  since_ms?: number;
}

export interface ListResult {
  items: AuditEntry[];
  total: number;
  chain_valid: boolean;
  tip_hash: string | null;
}

export async function listAudit(opts: ListOptions = {}): Promise<ListResult> {
  ensureDir();
  const p = LOG_PATH();
  if (!existsSync(p)) {
    return { items: [], total: 0, chain_valid: true, tip_hash: null };
  }
  const raw = await fs.readFile(p, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip corrupt line; chain check below will flag it
    }
  }

  let chainValid = true;
  let prev = GENESIS_HASH;
  for (const e of entries) {
    if (e.prev_hash !== prev) {
      chainValid = false;
      break;
    }
    const recomputed = hashEntry(e);
    if (recomputed !== e.hash) {
      chainValid = false;
      break;
    }
    prev = e.hash;
  }

  const tipHash = entries.length > 0 ? entries[entries.length - 1]!.hash : null;

  let filtered = entries.slice();
  if (opts.action) filtered = filtered.filter((e) => e.action === opts.action);
  if (opts.actor_user_id)
    filtered = filtered.filter((e) => e.actor_user_id === opts.actor_user_id);
  if (opts.outcome) filtered = filtered.filter((e) => e.outcome === opts.outcome);
  if (opts.since_ms !== undefined)
    filtered = filtered.filter((e) => e.ts >= opts.since_ms!);

  filtered.reverse();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  return {
    items: filtered.slice(0, limit),
    total: filtered.length,
    chain_valid: chainValid,
    tip_hash: tipHash,
  };
}

/** Test helper. */
export function _resetForTests() {
  cachedTail = undefined;
  writeQueue = Promise.resolve();
}
