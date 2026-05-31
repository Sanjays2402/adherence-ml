/**
 * Saved searches store: per-user, file-backed JSONL under
 * .data/saved-searches.jsonl. Mirrors the runs-store / notifications-store
 * pattern (pure stdlib, no native bindings) so it deploys without extra
 * infra and survives single-process restarts.
 *
 * Each record is the serialized history-page filter bar: q, kind, date
 * range, tags, pinned-only. Restoring a saved search re-applies those
 * filters one-click in the UI.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type SavedRunKind =
  | "all"
  | "predict"
  | "demo"
  | "explain"
  | "cohort"
  | "forecast"
  | "other";

export interface SavedSearchFilters {
  q: string;
  kind: SavedRunKind;
  from: string; // ISO yyyy-mm-dd or empty
  to: string;
  tags: string[];
  pinned_only: boolean;
}

export interface SavedSearchRecord {
  id: string;
  user_id: string; // owner; anonymous saved searches live under "_anon"
  name: string;
  created_at: number;
  updated_at: number;
  filters: SavedSearchFilters;
  /** soft-delete marker so we keep the JSONL append-only on disk */
  deleted?: boolean;
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "saved-searches.jsonl");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function newId(): string {
  return "ss_" + randomBytes(6).toString("base64url").slice(0, 10);
}

let writeQueue: Promise<void> = Promise.resolve();

async function appendLine(rec: SavedSearchRecord): Promise<void> {
  ensureDir();
  const line = JSON.stringify(rec) + "\n";
  writeQueue = writeQueue.then(() => fs.appendFile(FILE, line, "utf8"));
  return writeQueue;
}

async function readAll(): Promise<SavedSearchRecord[]> {
  ensureDir();
  if (!existsSync(FILE)) return [];
  const text = await fs.readFile(FILE, "utf8");
  const out: SavedSearchRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as SavedSearchRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

/**
 * Collapse the append-only log into the latest record per id, then drop
 * anything tombstoned. Cheap enough at the saved-search scale (a power
 * user might have dozens, never millions).
 */
async function snapshotFor(userId: string): Promise<SavedSearchRecord[]> {
  const all = await readAll();
  const latest = new Map<string, SavedSearchRecord>();
  for (const rec of all) {
    if (rec.user_id !== userId) continue;
    latest.set(rec.id, rec);
  }
  return [...latest.values()]
    .filter((r) => !r.deleted)
    .sort((a, b) => b.updated_at - a.updated_at);
}

export async function listSavedSearches(
  userId: string,
): Promise<SavedSearchRecord[]> {
  return snapshotFor(userId);
}

export async function getSavedSearch(
  userId: string,
  id: string,
): Promise<SavedSearchRecord | null> {
  const items = await snapshotFor(userId);
  return items.find((s) => s.id === id) ?? null;
}

export interface CreateSavedSearchInput {
  user_id: string;
  name: string;
  filters: SavedSearchFilters;
}

export async function createSavedSearch(
  input: CreateSavedSearchInput,
): Promise<SavedSearchRecord> {
  const now = Date.now();
  const rec: SavedSearchRecord = {
    id: newId(),
    user_id: input.user_id,
    name: input.name.trim().slice(0, 80) || "Untitled view",
    created_at: now,
    updated_at: now,
    filters: normalizeFilters(input.filters),
  };
  await appendLine(rec);
  return rec;
}

export async function renameSavedSearch(
  userId: string,
  id: string,
  name: string,
): Promise<SavedSearchRecord | null> {
  const existing = await getSavedSearch(userId, id);
  if (!existing) return null;
  const updated: SavedSearchRecord = {
    ...existing,
    name: name.trim().slice(0, 80) || existing.name,
    updated_at: Date.now(),
  };
  await appendLine(updated);
  return updated;
}

export async function deleteSavedSearch(
  userId: string,
  id: string,
): Promise<boolean> {
  const existing = await getSavedSearch(userId, id);
  if (!existing) return false;
  const tombstone: SavedSearchRecord = {
    ...existing,
    deleted: true,
    updated_at: Date.now(),
  };
  await appendLine(tombstone);
  return true;
}

const KINDS: SavedRunKind[] = [
  "all",
  "predict",
  "demo",
  "explain",
  "cohort",
  "forecast",
  "other",
];

export function normalizeFilters(
  raw: Partial<SavedSearchFilters> | undefined,
): SavedSearchFilters {
  const kindRaw = raw?.kind as SavedRunKind | undefined;
  const kind: SavedRunKind = kindRaw && KINDS.includes(kindRaw) ? kindRaw : "all";
  const dateOk = (s: string | undefined): string => {
    if (!s) return "";
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  };
  return {
    q: (raw?.q ?? "").toString().slice(0, 200),
    kind,
    from: dateOk(raw?.from),
    to: dateOk(raw?.to),
    tags: Array.isArray(raw?.tags)
      ? raw!.tags
          .map((t) => String(t).trim())
          .filter(Boolean)
          .slice(0, 12)
      : [],
    pinned_only: Boolean(raw?.pinned_only),
  };
}
