/**
 * Schedules store: file-backed CRUD for recurring prediction jobs.
 *
 * A "schedule" pairs a saved prediction payload with a cadence (daily or
 * weekly) and an hour-of-day. When `tick` is called (manually from the UI
 * or from an external cron hitting /api/schedules/tick) every schedule
 * whose next_run_at is in the past fires: the upstream FastAPI predictor
 * is called, a run is appended to history with a `scheduled` tag, and
 * next_run_at is rolled forward.
 *
 * Stays consistent with webhooks-store / api-keys-store conventions:
 * - JSON file at .data/schedules.json
 * - serialised writes via a queue
 * - no external dependencies
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type ScheduleCadence = "daily" | "weekly";

export interface ScheduleRun {
  at: number;
  ok: boolean;
  run_id: string | null;
  latency_ms: number | null;
  error: string | null;
}

export interface Schedule {
  id: string;
  name: string;
  cadence: ScheduleCadence;
  hour_utc: number; // 0..23
  weekday: number | null; // 0..6 (Sun=0), only for weekly
  payload: {
    user_id: string;
    doses: Array<{
      dose_id: string;
      scheduled_at: string;
      dose_class: string;
      dose_strength_mg: number;
    }>;
    top_k?: number;
  };
  active: boolean;
  created_at: number;
  next_run_at: number;
  last_run_at: number | null;
  success_count: number;
  failure_count: number;
  history: ScheduleRun[]; // most recent first, capped
}

interface Store {
  version: 1;
  schedules: Schedule[];
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "schedules.json");
const MAX_HISTORY = 25;

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return { version: 1, schedules: [] };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.schedules)) {
      return { version: 1, schedules: [] };
    }
    return parsed;
  } catch {
    return { version: 1, schedules: [] };
  }
}

async function writeStore(s: Store): Promise<void> {
  ensureDir();
  for (const sch of s.schedules) {
    if (sch.history.length > MAX_HISTORY) {
      sch.history = sch.history.slice(0, MAX_HISTORY);
    }
  }
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, STORE_PATH);
}

function newId(): string {
  return "sch_" + randomBytes(6).toString("base64url").slice(0, 10);
}

/**
 * Compute the next run timestamp in epoch ms, strictly after `from`.
 * Pure function so it can be tested without I/O.
 */
export function computeNextRunAt(
  cadence: ScheduleCadence,
  hourUtc: number,
  weekday: number | null,
  from: number,
): number {
  const d = new Date(from);
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 0, 0, 0),
  );
  if (cadence === "daily") {
    if (target.getTime() <= from) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    return target.getTime();
  }
  // weekly
  const wd = weekday ?? 0;
  const currentWd = target.getUTCDay();
  let delta = (wd - currentWd + 7) % 7;
  if (delta === 0 && target.getTime() <= from) delta = 7;
  target.setUTCDate(target.getUTCDate() + delta);
  return target.getTime();
}

export interface CreateScheduleInput {
  name: string;
  cadence: ScheduleCadence;
  hour_utc: number;
  weekday?: number | null;
  payload: Schedule["payload"];
}

export async function listSchedules(): Promise<Schedule[]> {
  const s = await readStore();
  return s.schedules.slice().sort((a, b) => b.created_at - a.created_at);
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const s = await readStore();
  return s.schedules.find((x) => x.id === id) ?? null;
}

export async function createSchedule(input: CreateScheduleInput): Promise<Schedule> {
  const now = Date.now();
  const sch: Schedule = {
    id: newId(),
    name: input.name.trim().slice(0, 80),
    cadence: input.cadence,
    hour_utc: Math.max(0, Math.min(23, Math.floor(input.hour_utc))),
    weekday:
      input.cadence === "weekly"
        ? Math.max(0, Math.min(6, Math.floor(input.weekday ?? 1)))
        : null,
    payload: input.payload,
    active: true,
    created_at: now,
    next_run_at: 0, // set below
    last_run_at: null,
    success_count: 0,
    failure_count: 0,
    history: [],
  };
  sch.next_run_at = computeNextRunAt(sch.cadence, sch.hour_utc, sch.weekday, now);
  await new Promise<void>((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const s = await readStore();
        s.schedules.push(sch);
        await writeStore(s);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  return sch;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  let removed = false;
  await new Promise<void>((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const s = await readStore();
        const before = s.schedules.length;
        s.schedules = s.schedules.filter((x) => x.id !== id);
        removed = s.schedules.length !== before;
        if (removed) await writeStore(s);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  return removed;
}

export async function setActive(id: string, active: boolean): Promise<Schedule | null> {
  let out: Schedule | null = null;
  await new Promise<void>((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const s = await readStore();
        const sch = s.schedules.find((x) => x.id === id);
        if (sch) {
          sch.active = active;
          if (active) {
            sch.next_run_at = computeNextRunAt(
              sch.cadence,
              sch.hour_utc,
              sch.weekday,
              Date.now(),
            );
          }
          out = sch;
          await writeStore(s);
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  return out;
}

export async function recordRun(
  id: string,
  result: ScheduleRun,
): Promise<Schedule | null> {
  let out: Schedule | null = null;
  await new Promise<void>((resolve, reject) => {
    writeQueue = writeQueue.then(async () => {
      try {
        const s = await readStore();
        const sch = s.schedules.find((x) => x.id === id);
        if (sch) {
          sch.last_run_at = result.at;
          if (result.ok) sch.success_count += 1;
          else sch.failure_count += 1;
          sch.history.unshift(result);
          sch.next_run_at = computeNextRunAt(
            sch.cadence,
            sch.hour_utc,
            sch.weekday,
            result.at,
          );
          out = sch;
          await writeStore(s);
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  return out;
}

export async function listDue(now: number = Date.now()): Promise<Schedule[]> {
  const s = await readStore();
  return s.schedules.filter((x) => x.active && x.next_run_at <= now);
}
