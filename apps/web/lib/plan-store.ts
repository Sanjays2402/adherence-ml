/**
 * Plan store: which billing tier this workspace is on, plus a change
 * history so /billing can show when a plan was upgraded or downgraded.
 *
 * File-backed JSON, same dependency-free pattern as runs-store,
 * settings-store, and usage-store. Single-tenant by design (one plan
 * per process). A multi-tenant SaaS would key by org_id / user_id.
 *
 * Stripe is intentionally not wired here. The /pricing -> /billing
 * flow is a real persisted plan change today, and swapping the
 * `checkout` handler for a Stripe Checkout Session is a one-file
 * change. See README -> "Billing & plans".
 */
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type PlanId = "free" | "pro" | "scale";

export interface Plan {
  id: PlanId;
  name: string;
  /** Requests per UTC day allowed against /v1/predict. */
  daily_quota: number;
  /** USD per month. 0 = free. */
  price_usd: number;
  /** Short user-facing features list. Rendered on /pricing. */
  features: string[];
  /** Used by /pricing to render the "most popular" ribbon. */
  highlight?: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    daily_quota: Number(process.env.ADHERENCE_FREE_DAILY_QUOTA ?? 500),
    price_usd: 0,
    features: [
      "500 predictions per day",
      "7 day history retention",
      "Community support",
      "Single workspace",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    daily_quota: Number(process.env.ADHERENCE_PRO_DAILY_QUOTA ?? 25_000),
    price_usd: 49,
    features: [
      "25,000 predictions per day",
      "90 day history retention",
      "Email support",
      "Webhook deliveries with retries",
      "CSV / JSON / NDJSON export",
    ],
    highlight: true,
  },
  scale: {
    id: "scale",
    name: "Scale",
    daily_quota: Number(process.env.ADHERENCE_SCALE_DAILY_QUOTA ?? 250_000),
    price_usd: 299,
    features: [
      "250,000 predictions per day",
      "Unlimited history retention",
      "Priority routing & SLA",
      "Audit log export",
      "SSO ready",
    ],
  },
};

export interface PlanChange {
  ts: number;
  from: PlanId;
  to: PlanId;
  /** Free-form note from the request body (eg. \"trial\", \"checkout-id\"). */
  reason: string;
}

export interface PlanState {
  version: 1;
  current: PlanId;
  changed_at: number;
  history: PlanChange[];
}

export const DEFAULT_STATE: PlanState = {
  version: 1,
  current: "free",
  changed_at: 0,
  history: [],
};

const DATA_DIR =
  process.env.ADHERENCE_DATA_DIR ?? path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "plan.json");

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

let writeQueue: Promise<void> = Promise.resolve();

export async function readPlan(): Promise<PlanState> {
  ensureDir();
  if (!existsSync(STORE_PATH)) return { ...DEFAULT_STATE };
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<PlanState>;
    const current = (parsed.current ?? "free") as PlanId;
    if (!(current in PLANS)) {
      return { ...DEFAULT_STATE };
    }
    return {
      version: 1,
      current,
      changed_at: parsed.changed_at ?? 0,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function writeState(s: PlanState): Promise<void> {
  ensureDir();
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, STORE_PATH);
}

export interface ChangePlanResult {
  state: PlanState;
  plan: Plan;
  changed: boolean;
}

export async function changePlan(
  to: PlanId,
  reason = "self-service",
): Promise<ChangePlanResult> {
  if (!(to in PLANS)) {
    throw new Error(`unknown plan: ${to}`);
  }
  const run = async (): Promise<ChangePlanResult> => {
    const prev = await readPlan();
    if (prev.current === to) {
      return { state: prev, plan: PLANS[to], changed: false };
    }
    const next: PlanState = {
      version: 1,
      current: to,
      changed_at: Date.now(),
      history: [
        ...prev.history,
        { ts: Date.now(), from: prev.current, to, reason: reason.slice(0, 200) },
      ].slice(-50),
    };
    await writeState(next);
    return { state: next, plan: PLANS[to], changed: true };
  };
  let result!: ChangePlanResult;
  writeQueue = writeQueue.then(async () => {
    result = await run();
  });
  await writeQueue;
  return result;
}

export async function currentPlan(): Promise<Plan> {
  const s = await readPlan();
  return PLANS[s.current];
}

export async function dailyQuota(): Promise<number> {
  const p = await currentPlan();
  return p.daily_quota;
}

// Test-only helper.
export async function _reset(): Promise<void> {
  if (existsSync(STORE_PATH)) await fs.rm(STORE_PATH);
}
