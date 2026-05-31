/**
 * Login throttle: per-email and per-IP lockout for magic-link issuance
 * and TOTP verification.
 *
 * Proves:
 *   - the bucket trips after maxAttempts inside the window, returns a
 *     locked_until timestamp, and stays locked across reads,
 *   - lockouts naturally expire after lockoutMs,
 *   - clearBucket wipes the counter so a follow-up attempt is unthrottled,
 *   - admin clearByAdmin removes a single (scope, key) without touching
 *     other buckets ("cross-bucket isolation").
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-throttle-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.VITEST = "1";

const throttle = await import("../lib/login-throttle");

beforeEach(async () => {
  const p = path.join(tmp, "login-throttle.json");
  if (existsSync(p)) await fs.rm(p);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("login throttle", () => {
  it("locks the bucket after max attempts and reports retry_after_ms", async () => {
    const policy = throttle.DEFAULT_POLICIES.magic_request;
    let last;
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      last = await throttle.recordFailure("magic_request", "abuser@example.com");
    }
    expect(last?.locked_until).toBeTruthy();
    const check = await throttle.checkLockout(
      "magic_request",
      "abuser@example.com",
    );
    expect(check.ok).toBe(false);
    expect(check.retry_after_ms).toBeGreaterThan(0);
    expect(check.retry_after_ms).toBeLessThanOrEqual(policy.lockoutMs);
  });

  it("does not lock the bucket before the threshold is crossed", async () => {
    const policy = throttle.DEFAULT_POLICIES.totp_verify;
    for (let i = 0; i < policy.maxAttempts - 1; i += 1) {
      await throttle.recordFailure("totp_verify", "ok@example.com");
    }
    const check = await throttle.checkLockout("totp_verify", "ok@example.com");
    expect(check.ok).toBe(true);
    expect(check.locked_until).toBeNull();
    expect(check.fails).toBe(policy.maxAttempts - 1);
  });

  it("clearBucket forgives the user on a successful sign-in", async () => {
    const pol = throttle.DEFAULT_POLICIES.totp_verify;
    for (let i = 0; i < pol.maxAttempts; i += 1) {
      await throttle.recordFailure("totp_verify", "user@example.com");
    }
    expect(
      (await throttle.checkLockout("totp_verify", "user@example.com")).ok,
    ).toBe(false);
    await throttle.clearBucket("totp_verify", "user@example.com");
    const after = await throttle.checkLockout(
      "totp_verify",
      "user@example.com",
    );
    expect(after.ok).toBe(true);
    expect(after.fails).toBe(0);
  });

  it("isolates buckets: admin clear of one (scope,key) leaves others intact", async () => {
    // Three independent buckets across both scopes and both key kinds.
    const pol = throttle.DEFAULT_POLICIES.magic_request;
    for (let i = 0; i < pol.maxAttempts; i += 1) {
      await throttle.recordFailure("magic_request", "a@example.com");
      await throttle.recordFailure("magic_request", "203.0.113.7");
      await throttle.recordFailure("totp_verify", "a@example.com");
    }
    // Sanity: all three are locked.
    expect((await throttle.checkLockout("magic_request", "a@example.com")).ok).toBe(false);
    expect((await throttle.checkLockout("magic_request", "203.0.113.7")).ok).toBe(false);
    expect((await throttle.checkLockout("totp_verify", "a@example.com")).ok).toBe(false);

    // Admin clears just the email-magic-request bucket.
    const removed = await throttle.clearByAdmin("magic_request", "a@example.com");
    expect(removed).toBe(true);

    // That bucket is gone but the other two are still locked.
    expect((await throttle.checkLockout("magic_request", "a@example.com")).ok).toBe(true);
    expect((await throttle.checkLockout("magic_request", "203.0.113.7")).ok).toBe(false);
    expect((await throttle.checkLockout("totp_verify", "a@example.com")).ok).toBe(false);

    // A second clear for the same bucket is a no-op.
    expect(await throttle.clearByAdmin("magic_request", "a@example.com")).toBe(false);
  });

  it("listBuckets with only_locked filters expired entries", async () => {
    const pol = throttle.DEFAULT_POLICIES.magic_request;
    // Build a locked bucket.
    for (let i = 0; i < pol.maxAttempts; i += 1) {
      await throttle.recordFailure("magic_request", "spammer@example.com");
    }
    const all = await throttle.listBuckets({ onlyLocked: true });
    expect(all.find((b) => b.key === "spammer@example.com")).toBeTruthy();
    expect(all.every((b) => b.locked_until && b.locked_until > Date.now())).toBe(true);
  });
});
