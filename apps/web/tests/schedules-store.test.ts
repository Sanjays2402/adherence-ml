/**
 * Smoke test for l@/lib/schedules-store.ts computeNextRunAt.
 * Run with: pnpm vitest run lib/__tests__/schedules.test.ts
 */
import { describe, it, expect } from "vitest";
import { computeNextRunAt } from "@/lib/schedules-store";

describe("computeNextRunAt", () => {
  it("daily: rolls to today if hour still ahead", () => {
    // 2025-06-15 04:00:00 UTC, target 08:00 UTC same day
    const from = Date.UTC(2025, 5, 15, 4, 0, 0);
    const got = computeNextRunAt("daily", 8, null, from);
    expect(got).toBe(Date.UTC(2025, 5, 15, 8, 0, 0));
  });

  it("daily: rolls to tomorrow if hour has passed", () => {
    const from = Date.UTC(2025, 5, 15, 9, 0, 0);
    const got = computeNextRunAt("daily", 8, null, from);
    expect(got).toBe(Date.UTC(2025, 5, 16, 8, 0, 0));
  });

  it("daily: rolls to tomorrow when exactly at target hour", () => {
    const from = Date.UTC(2025, 5, 15, 8, 0, 0);
    const got = computeNextRunAt("daily", 8, null, from);
    expect(got).toBe(Date.UTC(2025, 5, 16, 8, 0, 0));
  });

  it("weekly: picks correct weekday this week if still ahead", () => {
    // 2025-06-15 is a Sunday (weekday 0). Target Wednesday (3) at 12:00.
    const from = Date.UTC(2025, 5, 15, 5, 0, 0);
    const got = computeNextRunAt("weekly", 12, 3, from);
    expect(got).toBe(Date.UTC(2025, 5, 18, 12, 0, 0));
  });

  it("weekly: rolls forward 7 days when same weekday and hour has passed", () => {
    // 2025-06-15 Sunday 14:00; target Sunday (0) at 12:00 -> next Sunday
    const from = Date.UTC(2025, 5, 15, 14, 0, 0);
    const got = computeNextRunAt("weekly", 12, 0, from);
    expect(got).toBe(Date.UTC(2025, 5, 22, 12, 0, 0));
  });

  it("weekly: same weekday, hour still ahead -> today", () => {
    const from = Date.UTC(2025, 5, 15, 5, 0, 0); // Sunday 05:00
    const got = computeNextRunAt("weekly", 12, 0, from);
    expect(got).toBe(Date.UTC(2025, 5, 15, 12, 0, 0));
  });
});
