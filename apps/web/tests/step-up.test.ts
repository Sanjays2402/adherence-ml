/**
 * Step-up MFA gate: proves a fresh second factor is required for sensitive
 * admin actions when the user has TOTP enrolled, and that the gate is a
 * no-op for users without TOTP (so single-user / pre-2FA deployments are
 * never locked out of their own admin console).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-stepup-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";

const stepUp = await import("../lib/step-up");
const sessionsStore = await import("../lib/sessions-store");
const users = await import("../lib/users-store");

type Ctx = import("../lib/session").SessionContext;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_SESSION_SECRET;
});

async function newUser(email: string, withTotp: boolean) {
  const u = await users.getOrCreateUserByEmail(email);
  if (withTotp) {
    await users.setPendingTotpSecret(u.id, "JBSWY3DPEHPK3PXP");
    await users.enableTotp(u.id, ["aaaa-bbbb", "cccc-dddd"]);
  }
  return (await users.getUserById(u.id))!;
}

async function ctxFor(
  email: string,
  withTotp: boolean,
  lastMfaAt: number | null,
): Promise<Ctx> {
  const user = await newUser(email, withTotp);
  const rec = await sessionsStore.createSession({
    user_id: user.id,
    expires_at: Date.now() + 60_000,
    last_mfa_at: lastMfaAt,
  });
  return {
    user,
    payload: {
      uid: user.id,
      eml: user.email,
      iat: Date.now(),
      exp: Date.now() + 60_000,
      sid: rec.sid,
    },
  } as Ctx;
}

describe("step-up MFA gate", () => {
  it("passes through users with no TOTP and no workspace MFA policy", async () => {
    const ctx = await ctxFor("no-mfa@example.com", false, null);
    const d = await stepUp.evaluateStepUp(ctx);
    expect(d.ok).toBe(true);
    expect(d.totpEnrolled).toBe(false);
  });

  it("blocks TOTP-enrolled users whose session has no recent MFA proof", async () => {
    const ctx = await ctxFor("totp-stale@example.com", true, null);
    const d = await stepUp.evaluateStepUp(ctx);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("no_recent_mfa");
    expect(d.totpEnrolled).toBe(true);
  });

  it("passes TOTP-enrolled users whose session has a recent MFA stamp", async () => {
    const ctx = await ctxFor(
      "totp-fresh@example.com",
      true,
      Date.now() - 60_000,
    );
    const d = await stepUp.evaluateStepUp(ctx);
    expect(d.ok).toBe(true);
    expect(d.lastMfaAt).toBeGreaterThan(0);
  });

  it("blocks TOTP-enrolled users whose proof has expired beyond the window", async () => {
    const ctx = await ctxFor(
      "totp-expired@example.com",
      true,
      Date.now() - (stepUp.STEP_UP_MAX_AGE_MS + 5_000),
    );
    const d = await stepUp.evaluateStepUp(ctx);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("no_recent_mfa");
  });

  it("markSessionMfa updates last_mfa_at on the persisted session", async () => {
    const u = await users.getOrCreateUserByEmail("stamp@example.com");
    const rec = await sessionsStore.createSession({
      user_id: u.id,
      expires_at: Date.now() + 60_000,
    });
    expect(rec.last_mfa_at ?? null).toBeNull();
    const stamped = await sessionsStore.markSessionMfa(rec.sid, 123_456_789);
    expect(stamped?.last_mfa_at).toBe(123_456_789);
    const re = await sessionsStore.getSessionRecord(rec.sid);
    expect(re?.last_mfa_at).toBe(123_456_789);
  });

  it("stepUpDeniedResponse returns 403 with mfa_step_up_required code and a verify_url", async () => {
    const res = stepUp.stepUpDeniedResponse({
      ok: false,
      reason: "no_recent_mfa",
      lastMfaAt: null,
      totpEnrolled: true,
      policyRequires: false,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("mfa_step_up_required");
    expect(body.step_up.verify_url).toBe("/api/auth/2fa/step-up");
    expect(body.step_up.totp_enrolled).toBe(true);
  });
});
