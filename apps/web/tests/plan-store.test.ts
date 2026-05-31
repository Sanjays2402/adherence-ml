import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-plan-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_FREE_DAILY_QUOTA = "100";
process.env.ADHERENCE_PRO_DAILY_QUOTA = "5000";
process.env.ADHERENCE_SCALE_DAILY_QUOTA = "50000";

const plan = await import("../lib/plan-store");
const usage = await import("../lib/usage-store");

beforeEach(async () => {
  await plan._reset();
  await usage._reset();
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_FREE_DAILY_QUOTA;
  delete process.env.ADHERENCE_PRO_DAILY_QUOTA;
  delete process.env.ADHERENCE_SCALE_DAILY_QUOTA;
});

describe("plan-store", () => {
  it("starts on the free plan with empty history", async () => {
    const s = await plan.readPlan();
    expect(s.current).toBe("free");
    expect(s.history).toEqual([]);
    const cur = await plan.currentPlan();
    expect(cur.id).toBe("free");
    expect(cur.daily_quota).toBe(100);
  });

  it("changePlan persists, records history, and updates the active quota", async () => {
    const r1 = await plan.changePlan("pro", "checkout:test1");
    expect(r1.changed).toBe(true);
    expect(r1.plan.id).toBe("pro");
    expect(r1.state.history).toHaveLength(1);
    expect(r1.state.history[0]).toMatchObject({ from: "free", to: "pro", reason: "checkout:test1" });

    // Re-read survives a fresh process boundary (file backed).
    const s = await plan.readPlan();
    expect(s.current).toBe("pro");

    // dailyQuota reflects the new plan.
    expect(await plan.dailyQuota()).toBe(5000);

    // Idempotent: same plan again does not append history.
    const r2 = await plan.changePlan("pro", "noop");
    expect(r2.changed).toBe(false);
    expect(r2.state.history).toHaveLength(1);
  });

  it("usage summary uses the plan quota instead of the free constant", async () => {
    expect((await usage.summary()).quota).toBe(100);
    await plan.changePlan("scale");
    const s = await usage.summary();
    expect(s.quota).toBe(50000);
    // remaining recomputed against the higher quota
    expect(s.remaining_today).toBe(50000);
  });

  it("rejects unknown plan ids", async () => {
    // @ts-expect-error - testing invalid input
    await expect(plan.changePlan("enterprise")).rejects.toThrow();
  });
});
