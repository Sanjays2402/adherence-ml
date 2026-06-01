/**
 * Tests for the expiring-soon helper that drives /api/keys/expiring
 * and the banner on /api-keys.
 *
 * Pins down the contract that procurement reviews care about:
 *   - Revoked keys never appear (rotating doesn't haunt operators).
 *   - Already-expired keys are not "soon" (they are a different alert).
 *   - Never-expires keys are silent.
 *   - Sort order is nearest-to-expiry first.
 *   - The window clamps to a sane upper bound and rejects garbage.
 *
 * Uses a throwaway ADHERENCE_DATA_DIR so it can run alongside the
 * other api-keys-store tests without contaminating real data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterAll } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "api-keys-expiring-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/api-keys-store");

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

function dayMs(d: number): number {
  return d * 24 * 60 * 60 * 1000;
}

describe("api-keys-store expiring-soon", () => {
  it("pickExpiringSoon filters and sorts correctly", () => {
    const now = 1_800_000_000_000;
    const keys = [
      // Inside window, 5d.
      { id: "a", name: "near", prefix: "adh_a", scopes: ["predict"], expires_at: now + dayMs(5), revoked: false, created_at: 0, last_used_at: null, use_count: 0, rotated_at: null, daily_quota: null, allowed_cidrs: null, last_used_ip: null, last_used_user_agent: null },
      // Outside 14d window.
      { id: "b", name: "later", prefix: "adh_b", scopes: ["read"], expires_at: now + dayMs(60), revoked: false, created_at: 0, last_used_at: null, use_count: 0, rotated_at: null, daily_quota: null, allowed_cidrs: null, last_used_ip: null, last_used_user_agent: null },
      // Already expired (handled by a different alert, not "soon").
      { id: "c", name: "dead", prefix: "adh_c", scopes: ["read"], expires_at: now - dayMs(1), revoked: false, created_at: 0, last_used_at: null, use_count: 0, rotated_at: null, daily_quota: null, allowed_cidrs: null, last_used_ip: null, last_used_user_agent: null },
      // Revoked (must never surface even if it would otherwise match).
      { id: "d", name: "killed", prefix: "adh_d", scopes: ["read"], expires_at: now + dayMs(2), revoked: true, created_at: 0, last_used_at: null, use_count: 0, rotated_at: null, daily_quota: null, allowed_cidrs: null, last_used_ip: null, last_used_user_agent: null },
      // Never expires.
      { id: "e", name: "forever", prefix: "adh_e", scopes: ["read"], expires_at: null, revoked: false, created_at: 0, last_used_at: null, use_count: 0, rotated_at: null, daily_quota: null, allowed_cidrs: null, last_used_ip: null, last_used_user_agent: null },
      // Inside window, 1d (must sort first).
      { id: "f", name: "urgent", prefix: "adh_f", scopes: ["audit"], expires_at: now + dayMs(1), revoked: false, created_at: 0, last_used_at: now - dayMs(2), use_count: 0, rotated_at: null, daily_quota: null, allowed_cidrs: null, last_used_ip: "10.0.0.5", last_used_user_agent: null },
    ] as unknown as Parameters<typeof store.pickExpiringSoon>[0];

    const out = store.pickExpiringSoon(keys, 14, now);
    expect(out.map((k) => k.id)).toEqual(["f", "a"]);
    expect(out[0].days_remaining).toBe(1);
    expect(out[1].days_remaining).toBe(5);
    expect(out[0].last_used_ip).toBe("10.0.0.5");
    expect(out[0].scopes).toEqual(["audit"]);
  });

  it("clamps absurd window sizes to MAX_EXPIRING_SOON_WINDOW_DAYS", () => {
    const now = 1_800_000_000_000;
    const keys = [
      { id: "x", name: "year-out", prefix: "adh_x", scopes: ["read"], expires_at: now + dayMs(200), revoked: false, created_at: 0, last_used_at: null, use_count: 0, rotated_at: null, daily_quota: null, allowed_cidrs: null, last_used_ip: null, last_used_user_agent: null },
      { id: "y", name: "far-out", prefix: "adh_y", scopes: ["read"], expires_at: now + dayMs(400), revoked: false, created_at: 0, last_used_at: null, use_count: 0, rotated_at: null, daily_quota: null, allowed_cidrs: null, last_used_ip: null, last_used_user_agent: null },
    ] as unknown as Parameters<typeof store.pickExpiringSoon>[0];

    // 200 days fits inside the 365-day max, 400 days does not.
    const out = store.pickExpiringSoon(keys, 99_999, now);
    expect(out.map((k) => k.id)).toEqual(["x"]);
    expect(store.MAX_EXPIRING_SOON_WINDOW_DAYS).toBe(365);
  });

  it("findExpiringSoon round-trips through the real on-disk store", async () => {
    const now = Date.now();
    await store.createKey("integration-warn", ["predict"], now + dayMs(3), null);
    await store.createKey("integration-far", ["predict"], now + dayMs(180), null);
    await store.createKey("integration-forever", ["predict"], null, null);

    const out = await store.findExpiringSoon(14, now);
    const names = out.map((k) => k.name);
    expect(names).toContain("integration-warn");
    expect(names).not.toContain("integration-far");
    expect(names).not.toContain("integration-forever");
  });
});
