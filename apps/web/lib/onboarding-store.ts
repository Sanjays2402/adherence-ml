/**
 * Onboarding state. Tracks which of the three first-run steps the
 * operator has completed and whether the sample workspace has been
 * seeded. File-backed JSON, same pattern as settings-store.
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type StepId = "explore_demo" | "issue_key" | "save_run";

export const STEP_IDS: StepId[] = ["explore_demo", "issue_key", "save_run"];

export interface OnboardingState {
  version: 1;
  completed: StepId[];
  dismissed: boolean;
  seeded_at: number | null;
  updated_at: number;
}

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "onboarding.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function defaultState(): OnboardingState {
  return {
    version: 1,
    completed: [],
    dismissed: false,
    seeded_at: null,
    updated_at: Date.now(),
  };
}

let writeQueue: Promise<void> = Promise.resolve();

export async function readOnboarding(): Promise<OnboardingState> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return defaultState();
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    const def = defaultState();
    const completed = Array.isArray(parsed.completed)
      ? (parsed.completed.filter((s) =>
          STEP_IDS.includes(s as StepId),
        ) as StepId[])
      : [];
    return {
      version: 1,
      completed,
      dismissed: Boolean(parsed.dismissed),
      seeded_at:
        typeof parsed.seeded_at === "number" ? parsed.seeded_at : null,
      updated_at: parsed.updated_at ?? def.updated_at,
    };
  } catch {
    return defaultState();
  }
}

async function writeRaw(s: OnboardingState): Promise<void> {
  ensureDir();
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, STORE_PATH);
}

export async function markStep(
  step: StepId,
  done: boolean,
): Promise<OnboardingState> {
  writeQueue = writeQueue.then(async () => {
    const cur = await readOnboarding();
    const set = new Set(cur.completed);
    if (done) set.add(step);
    else set.delete(step);
    cur.completed = STEP_IDS.filter((s) => set.has(s));
    cur.updated_at = Date.now();
    await writeRaw(cur);
  });
  await writeQueue;
  return readOnboarding();
}

export async function setDismissed(
  dismissed: boolean,
): Promise<OnboardingState> {
  writeQueue = writeQueue.then(async () => {
    const cur = await readOnboarding();
    cur.dismissed = dismissed;
    cur.updated_at = Date.now();
    await writeRaw(cur);
  });
  await writeQueue;
  return readOnboarding();
}

export async function markSeeded(): Promise<OnboardingState> {
  writeQueue = writeQueue.then(async () => {
    const cur = await readOnboarding();
    cur.seeded_at = Date.now();
    cur.updated_at = Date.now();
    await writeRaw(cur);
  });
  await writeQueue;
  return readOnboarding();
}

export function progress(state: OnboardingState): {
  done: number;
  total: number;
  pct: number;
} {
  const total = STEP_IDS.length;
  const done = state.completed.length;
  return { done, total, pct: Math.round((done / total) * 100) };
}
