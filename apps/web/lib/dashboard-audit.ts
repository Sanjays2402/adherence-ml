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
  action_prefix?: string;
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
  if (opts.action_prefix) {
    const pfx = opts.action_prefix;
    filtered = filtered.filter((e) => e.action.startsWith(pfx));
  }
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

/**
 * Detailed integrity report for the dashboard audit chain.
 *
 * Walks every persisted entry, recomputes its SHA-256, and confirms the
 * `prev_hash` linkage. On the first violation it records the position and
 * the entry id so a SOC2 reviewer can point at the exact broken row.
 */
export interface AuditChainReport {
  entries: number;
  /** True if every recomputed hash matches and every prev_hash links. */
  chain_valid: boolean;
  /** Hash of the latest entry, or null when the log is empty. */
  tip_hash: string | null;
  /** Timestamp (ms) of the latest entry, or null when empty. */
  tip_ts: number | null;
  /** Timestamp (ms) of the first entry, or null when empty. */
  head_ts: number | null;
  /** Genesis sentinel; included so verifiers do not need to hardcode it. */
  genesis_hash: string;
  /** 0-based index of the first broken entry, or null when chain is valid. */
  first_break_index: number | null;
  /** id of the first broken entry, or null when chain is valid. */
  first_break_id: string | null;
  /** Human-readable reason for the break, or null. */
  first_break_reason: string | null;
  /** True when at least one stored line failed JSON.parse. */
  has_corrupt_lines: boolean;
  /** ISO timestamp (UTC) for when the report was produced. */
  verified_at: string;
}

export async function verifyAuditChain(): Promise<AuditChainReport> {
  ensureDir();
  const p = LOG_PATH();
  const verifiedAt = new Date().toISOString();
  if (!existsSync(p)) {
    return {
      entries: 0,
      chain_valid: true,
      tip_hash: null,
      tip_ts: null,
      head_ts: null,
      genesis_hash: GENESIS_HASH,
      first_break_index: null,
      first_break_id: null,
      first_break_reason: null,
      has_corrupt_lines: false,
      verified_at: verifiedAt,
    };
  }
  const raw = await fs.readFile(p, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  let hasCorrupt = false;
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      hasCorrupt = true;
    }
  }

  let prev = GENESIS_HASH;
  let firstBreakIndex: number | null = null;
  let firstBreakId: string | null = null;
  let firstBreakReason: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.prev_hash !== prev) {
      firstBreakIndex = i;
      firstBreakId = e.id;
      firstBreakReason = `prev_hash mismatch at index ${i}`;
      break;
    }
    const recomputed = hashEntry(e);
    if (recomputed !== e.hash) {
      firstBreakIndex = i;
      firstBreakId = e.id;
      firstBreakReason = `hash mismatch at index ${i}`;
      break;
    }
    prev = e.hash;
  }
  const chainValid = firstBreakIndex === null && !hasCorrupt;
  if (hasCorrupt && firstBreakReason === null) {
    firstBreakReason = "one or more lines failed to parse";
  }

  return {
    entries: entries.length,
    chain_valid: chainValid,
    tip_hash: entries.length > 0 ? entries[entries.length - 1]!.hash : null,
    tip_ts: entries.length > 0 ? entries[entries.length - 1]!.ts : null,
    head_ts: entries.length > 0 ? entries[0]!.ts : null,
    genesis_hash: GENESIS_HASH,
    first_break_index: firstBreakIndex,
    first_break_id: firstBreakId,
    first_break_reason: firstBreakReason,
    has_corrupt_lines: hasCorrupt,
    verified_at: verifiedAt,
  };
}

/**
 * Build a signed evidence bundle of the entire audit log.
 *
 * The bundle is a single JSON document with three sections:
 *   - `manifest`: schema id, generation timestamp, counts, hash algorithm,
 *     genesis hash, head and tip hashes, and a SHA-256 over the canonical
 *     concatenation of every entry hash (the "merkle-lite root"). A buyer
 *     security team can recompute this root from the entries alone.
 *   - `report`: the chain integrity report from {@link verifyAuditChain}.
 *   - `entries`: every audit entry in chronological order.
 */
export interface AuditBundleManifest {
  schema: "adherence.audit.bundle.v1";
  generated_at: string;
  workspace_id: string | null;
  generator: { app: string; version: string };
  hash_algorithm: "sha256";
  entry_count: number;
  genesis_hash: string;
  head_hash: string | null;
  tip_hash: string | null;
  /** sha256 over `entry[0].hash + entry[1].hash + ... + entry[N-1].hash`. */
  entries_root: string;
}

export interface AuditBundle {
  manifest: AuditBundleManifest;
  report: AuditChainReport;
  entries: AuditEntry[];
}

export interface BundleOptions {
  workspace_id?: string | null;
  generator_version?: string;
}

export async function exportAuditBundle(
  opts: BundleOptions = {},
): Promise<AuditBundle> {
  ensureDir();
  const p = LOG_PATH();
  const entries: AuditEntry[] = [];
  if (existsSync(p)) {
    const raw = await fs.readFile(p, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // skip; the report below will flag it
      }
    }
  }
  const report = await verifyAuditChain();
  const root = createHash("sha256");
  for (const e of entries) root.update(e.hash);
  const entriesRoot = root.digest("hex");

  const manifest: AuditBundleManifest = {
    schema: "adherence.audit.bundle.v1",
    generated_at: new Date().toISOString(),
    workspace_id: opts.workspace_id ?? null,
    generator: { app: "adherence-ml", version: opts.generator_version ?? "1" },
    hash_algorithm: "sha256",
    entry_count: entries.length,
    genesis_hash: GENESIS_HASH,
    head_hash: entries.length > 0 ? entries[0]!.hash : null,
    tip_hash: entries.length > 0 ? entries[entries.length - 1]!.hash : null,
    entries_root: entriesRoot,
  };

  return { manifest, report, entries };
}

/** Test helper. */
export function _resetForTests() {
  cachedTail = undefined;
  writeQueue = Promise.resolve();
}
