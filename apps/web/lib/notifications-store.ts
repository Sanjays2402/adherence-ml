/**
 * In-app notifications store. File-backed JSONL under .data/notifications.jsonl
 * to match the runs-store pattern (pure stdlib, deploys without extra infra).
 *
 * Notifications are per-user. A null user_id means "broadcast to every
 * signed-in user" and is rendered for everyone until they personally
 * mark it read (read-state is stored per (user_id, notification_id) pair
 * inside a small JSON sidecar so a broadcast does not need to be cloned
 * for every account).
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type NotificationKind =
  | "run.completed"
  | "batch.completed"
  | "webhook.failed"
  | "webhook.delivered"
  | "system";

export interface NotificationRecord {
  id: string;
  created_at: number;
  user_id: string | null; // null = broadcast
  kind: NotificationKind;
  title: string;
  body: string;
  href: string | null; // optional deep-link to a run / delivery / page
  read: boolean; // per-record read flag for targeted notifications
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "notifications.jsonl");
const READ_FILE = path.join(DATA_DIR, "notification-reads.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function newId(): string {
  return randomBytes(8).toString("base64url").slice(0, 12);
}

let writeQueue: Promise<void> = Promise.resolve();

export interface CreateNotificationInput {
  user_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  href?: string | null;
}

export async function createNotification(
  input: CreateNotificationInput,
): Promise<NotificationRecord> {
  ensureDir();
  const rec: NotificationRecord = {
    id: newId(),
    created_at: Date.now(),
    user_id: input.user_id,
    kind: input.kind,
    title: input.title.slice(0, 200),
    body: input.body.slice(0, 2000),
    href: input.href ?? null,
    read: false,
  };
  const line = JSON.stringify(rec) + "\n";
  writeQueue = writeQueue.then(() => fs.appendFile(FILE, line, "utf8"));
  await writeQueue;
  return rec;
}

async function readAll(): Promise<NotificationRecord[]> {
  ensureDir();
  if (!existsSync(FILE)) return [];
  const text = await fs.readFile(FILE, "utf8");
  const out: NotificationRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as NotificationRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

interface ReadIndex {
  // map of "userId|notificationId" -> true
  [key: string]: true;
}

async function readReadIndex(): Promise<ReadIndex> {
  ensureDir();
  if (!existsSync(READ_FILE)) return {};
  try {
    return JSON.parse(await fs.readFile(READ_FILE, "utf8")) as ReadIndex;
  } catch {
    return {};
  }
}

async function writeReadIndex(idx: ReadIndex): Promise<void> {
  ensureDir();
  await fs.writeFile(READ_FILE, JSON.stringify(idx), "utf8");
}

export interface ListOptions {
  unreadOnly?: boolean;
  limit?: number;
}

export interface NotificationView extends NotificationRecord {
  read_for_user: boolean;
}

export async function listForUser(
  userId: string | null,
  opts: ListOptions = {},
): Promise<NotificationView[]> {
  const all = await readAll();
  const idx = await readReadIndex();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const visible = all.filter(
    (n) => n.user_id === null || (userId !== null && n.user_id === userId),
  );

  const mapped: NotificationView[] = visible.map((n) => {
    const targetedRead = n.user_id !== null && n.read;
    const broadcastRead =
      n.user_id === null && userId !== null && !!idx[`${userId}|${n.id}`];
    return { ...n, read_for_user: targetedRead || broadcastRead };
  });

  const filtered = opts.unreadOnly
    ? mapped.filter((n) => !n.read_for_user)
    : mapped;

  // newest first
  filtered.sort((a, b) => b.created_at - a.created_at);
  return filtered.slice(0, limit);
}

export async function unreadCountForUser(
  userId: string | null,
): Promise<number> {
  const items = await listForUser(userId, { unreadOnly: true, limit: 500 });
  return items.length;
}

export async function markRead(
  userId: string | null,
  notificationId: string,
): Promise<boolean> {
  const all = await readAll();
  const found = all.find((n) => n.id === notificationId);
  if (!found) return false;
  // permission: must be owner or a broadcast
  if (found.user_id !== null && found.user_id !== userId) return false;

  if (found.user_id !== null) {
    // rewrite the JSONL file with this record flipped to read=true
    found.read = true;
    const out = all.map((n) => JSON.stringify(n)).join("\n") + "\n";
    writeQueue = writeQueue.then(() => fs.writeFile(FILE, out, "utf8"));
    await writeQueue;
  } else if (userId) {
    const idx = await readReadIndex();
    idx[`${userId}|${notificationId}`] = true;
    await writeReadIndex(idx);
  }
  return true;
}

export async function markAllRead(userId: string | null): Promise<number> {
  if (!userId) return 0;
  const all = await readAll();
  let n = 0;
  let mutated = false;
  for (const rec of all) {
    if (rec.user_id === userId && !rec.read) {
      rec.read = true;
      mutated = true;
      n++;
    }
  }
  if (mutated) {
    const out = all.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeQueue = writeQueue.then(() => fs.writeFile(FILE, out, "utf8"));
    await writeQueue;
  }
  const idx = await readReadIndex();
  for (const rec of all) {
    if (rec.user_id === null) {
      const k = `${userId}|${rec.id}`;
      if (!idx[k]) {
        idx[k] = true;
        n++;
      }
    }
  }
  await writeReadIndex(idx);
  return n;
}

/** Test helper: wipe both files. */
export async function __resetForTests(): Promise<void> {
  if (existsSync(FILE)) await fs.unlink(FILE);
  if (existsSync(READ_FILE)) await fs.unlink(READ_FILE);
}
