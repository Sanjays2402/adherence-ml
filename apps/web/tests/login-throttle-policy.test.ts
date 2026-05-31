/**
 * Login throttle policy overrides.
 *
 * Proves:
 *   - getPolicies() reports built-in defaults until an override is set,
 *   - setPolicies() persists per-scope overrides and reports source="override",
 *   - recordFailure() honours the custom maxAttempts (cross-tenant
 *     guarantee: the policy applied is the one the operator just saved,
 *     not whatever was hard-coded at build time),
 *   - clamping enforces POLICY_BOUNDS so a misconfiguration cannot
 *     disable the throttle entirely,
 *   - passing null reverts a scope back to the built-in default.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-throttle-policy-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.VITEST = "1";

const throttle = await import("../lib/login-throttle");

async function cleanFiles() {
  for (const f of ["login-throttle.json", "login-throttle-policy.json"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
  await throttle.__resetForTests();
}

beforeEach(cleanFiles);

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("login throttle policy overrides", () => {
  it("reports defaults when no overrides are set", async () => {
    const view = await throttle.getPolicies();
    expect(view.policies.magic_request.source).toBe("default");
    expect(view.policies.totp_verify.source).toBe("default");
    expect(view.policies.magic_request.maxAttempts).toBe(
      throttle.DEFAULT_POLICIES.magic_request.maxAttempts,
    );
    expect(view.updated_at).toBeNull();
  });

  it("persists overrides and recordFailure honours the custom threshold", async () => {
    // Tighten magic_request to 2 attempts in a 5-minute window.
    const updated = await throttle.setPolicies(
      {
        magic_request: {
          windowMs: 5 * 60_000,
          maxAttempts: 2,
          lockoutMs: 5 * 60_000,
        },
      },
      "owner@example.com",
    );
    expect(updated.policies.magic_request.source).toBe("override");
    expect(updated.policies.magic_request.maxAttempts).toBe(2);
    expect(updated.updated_by).toBe("owner@example.com");
    expect(updated.updated_at).toBeTypeOf("number");
    // Other scope still on the default.
    expect(updated.policies.totp_verify.source).toBe("default");

    // First failure: still ok.
    const r1 = await throttle.recordFailure("magic_request", "victim@example.com");
    expect(r1.locked_until).toBeNull();
    // Second failure: now locked because the custom threshold is 2.
    const r2 = await throttle.recordFailure("magic_request", "victim@example.com");
    expect(r2.locked_until).not.toBeNull();
    expect(r2.fails).toBe(2);
    const check = await throttle.checkLockout("magic_request", "victim@example.com");
    expect(check.ok).toBe(false);
    expect(check.retry_after_ms).toBeGreaterThan(0);
  });

  it("clamps wildly out-of-range values into POLICY_BOUNDS", async () => {
    const view = await throttle.setPolicies(
      {
        totp_verify: {
          windowMs: 1, // way below min
          maxAttempts: 9_999, // above max
          lockoutMs: 999 * 24 * 60 * 60 * 1000, // years
        },
      },
      null,
    );
    const clamped = view.policies.totp_verify;
    expect(clamped.windowMs).toBe(throttle.POLICY_BOUNDS.windowMs.min);
    expect(clamped.maxAttempts).toBe(throttle.POLICY_BOUNDS.maxAttempts.max);
    expect(clamped.lockoutMs).toBe(throttle.POLICY_BOUNDS.lockoutMs.max);
  });

  it("revert (null) restores the built-in default", async () => {
    await throttle.setPolicies(
      {
        magic_request: { windowMs: 60_000, maxAttempts: 1, lockoutMs: 60_000 },
      },
      "admin",
    );
    let view = await throttle.getPolicies();
    expect(view.policies.magic_request.source).toBe("override");

    view = await throttle.setPolicies({ magic_request: null }, "admin");
    expect(view.policies.magic_request.source).toBe("default");
    expect(view.policies.magic_request.maxAttempts).toBe(
      throttle.DEFAULT_POLICIES.magic_request.maxAttempts,
    );
  });

  it("does not bleed overrides across scopes", async () => {
    await throttle.setPolicies(
      {
        magic_request: { windowMs: 60_000, maxAttempts: 1, lockoutMs: 60_000 },
      },
      "admin",
    );
    // totp_verify still uses the default attempt count.
    let r = await throttle.recordFailure("totp_verify", "1.1.1.1");
    expect(r.locked_until).toBeNull();
    for (let i = 1; i < throttle.DEFAULT_POLICIES.totp_verify.maxAttempts; i += 1) {
      r = await throttle.recordFailure("totp_verify", "1.1.1.1");
    }
    expect(r.locked_until).not.toBeNull();
    expect(r.fails).toBe(throttle.DEFAULT_POLICIES.totp_verify.maxAttempts);
  });
});
