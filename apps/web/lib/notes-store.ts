/**
 * Notes store: append-only JSONL of timestamped annotations on runs.
 *
 * Each run can carry zero or more notes authored by a logged-in user
 * (or anonymously). Stored at .data/notes.jsonl so it lives next to the
 * runs store and survives restarts. Deletions are tombstones, never
 * destructive rewrites, so the file stays append-only and cheap.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface NoteRecord {
  id: string;
  run_id: string;
  created_at: number;
  user_id: string | null;
  author_email: string | null;
  body: string;
  deleted?: boolean;
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const NOTES_FILE = path.join(DATA_DIR, "notes.jsonl");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function newNoteId(): string {
  return "n_" + randomBytes(8).toString("base64url").slice(0, 12);
}

let writeQueue: Promise<void> = Promise.resolve();

async function appendLine(rec: object): Promise<void> {
  ensureDir();
  const line = JSON.stringify(rec) + "\n";
  writeQueue = writeQueue.then(() => fs.appendFile(NOTES_FILE, line, "utf8"));
  return writeQueue;
}

async function readAll(): Promise<NoteRecord[]> {
  ensureDir();
  if (!existsSync(NOTES_FILE)) return [];
  const text = await fs.readFile(NOTES_FILE, "utf8");
  const out: NoteRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as NoteRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

/** Collapse tombstones: later `deleted:true` records hide earlier inserts. */
function collapse(all: NoteRecord[]): NoteRecord[] {
  const byId = new Map<string, NoteRecord>();
  for (const r of all) {
    const prev = byId.get(r.id);
    if (!prev) {
      byId.set(r.id, r);
    } else {
      // merge: keep original fields but apply later flags
      byId.set(r.id, { ...prev, ...r });
    }
  }
  return [...byId.values()].filter((r) => !r.deleted);
}

export async function listNotesForRun(runId: string): Promise<NoteRecord[]> {
  const all = await readAll();
  const mine = all.filter((r) => r.run_id === runId);
  return collapse(mine).sort((a, b) => a.created_at - b.created_at);
}

export async function countNotesForRun(runId: string): Promise<number> {
  return (await listNotesForRun(runId)).length;
}

export interface CreateNoteInput {
  run_id: string;
  body: string;
  user_id: string | null;
  author_email: string | null;
}

export async function createNote(input: CreateNoteInput): Promise<NoteRecord> {
  const body = input.body.trim();
  if (!body) throw new Error("note body is empty");
  if (body.length > 2000) throw new Error("note body too long");
  const rec: NoteRecord = {
    id: newNoteId(),
    run_id: input.run_id,
    created_at: Date.now(),
    user_id: input.user_id,
    author_email: input.author_email,
    body,
  };
  await appendLine(rec);
  return rec;
}

/**
 * Soft-delete a note. Returns true if the note existed and was authored by
 * `userId` (or `userId` is null and the note was anonymous), false otherwise.
 * Anonymous notes can only be deleted by anonymous callers.
 */
export async function deleteNote(
  noteId: string,
  userId: string | null,
): Promise<boolean> {
  const all = await readAll();
  const collapsed = collapse(all);
  const existing = collapsed.find((r) => r.id === noteId);
  if (!existing) return false;
  if ((existing.user_id ?? null) !== (userId ?? null)) return false;
  await appendLine({ ...existing, deleted: true });
  return true;
}

/**
 * GDPR / right-to-erasure helper. Soft-deletes every note authored by
 * `userId` AND scrubs the author_email field on the tombstones so the
 * tombstones themselves carry no PII. Returns the number of notes
 * tombstoned. Used by lib/account-erase.ts.
 */
export async function purgeNotesForUser(userId: string): Promise<number> {
  if (!userId) return 0;
  const all = await readAll();
  const collapsed = collapse(all);
  const mine = collapsed.filter((r) => r.user_id === userId);
  let count = 0;
  for (const n of mine) {
    await appendLine({
      ...n,
      user_id: null,
      author_email: null,
      body: "",
      deleted: true,
    });
    count += 1;
  }
  return count;
}
