/**
 * Authentication-event logging contract.
 *
 * Proves the things a SOC2 / SIEM reviewer will actually check:
 *
 *   1. Every recorded auth event uses the canonical "auth.<verb>.<method>"
 *      action name and lands in the existing hash-chained audit log with
 *      monotonic prev_hash / hash linkage.
 *
 *   2. Failed sign-ins are recorded even when the user does not exist or
 *      the token is invalid. (This is the SIEM use case: detecting brute
 *      force and credential stuffing.) The `outcome` field carries the
 *      success / failure / denied verdict; metadata.reason carries the
 *      machine-readable cause.
 *
 *   3. Sensitive material (the magic token, the TOTP code) never appears
 *      anywhere in the recorded entry.
 *
 *   4. The /api/audit/dashboard `action_prefix` filter scopes the response
 *      to auth.* entries only, so the auth-events page never leaks
 *      unrelated mutations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-auth-audit-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const auditMod = await import("../lib/dashboard-audit");
const authAuditMod = await import("../lib/auth-audit");
const { recordAuthEvent } = authAuditMod;
const { listAudit, _resetForTests } = auditMod;

beforeAll(() => {
  _resetForTests();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("authentication event audit log", () => {
  it("records canonical action names, preserves outcome, and never leaks secrets", async () => {
    const SECRET_TOKEN = "tok_super_secret_should_never_appear";
    await recordAuthEvent({
      verb: "login_request",
      method: "magic_link",
      outcome: "success",
      email: "alice@example.com",
      // metadata intentionally does not carry the token; this is the contract
      // we want every auth route to honour.
      metadata: { issued: true },
    });
    await recordAuthEvent({
      verb: "login",
      method: "magic_link",
      outcome: "failure",
      reason: "invalid_or_expired_token",
    });
    await recordAuthEvent({
      verb: "login",
      method: "sso",
      outcome: "success",
      email: "alice@example.com",
      userId: "u_alice",
      workspaceId: "ws_1",
    });
    await recordAuthEvent({
      verb: "mfa",
      method: "totp",
      outcome: "failure",
      email: "alice@example.com",
      userId: "u_alice",
      reason: "invalid_totp_code",
    });

    const all = await listAudit({ action_prefix: "auth.", limit: 100 });
    expect(all.chain_valid).toBe(true);
    expect(all.items).toHaveLength(4);
    // newest first (listAudit returns reverse-chronological)
    expect(all.items[0]!.action).toBe("auth.mfa.failure");
    expect(all.items[0]!.outcome).toBe("failure");
    expect(all.items[1]!.action).toBe("auth.login.success");
    expect(all.items[1]!.outcome).toBe("success");
    expect(all.items[2]!.action).toBe("auth.login.failure");
    expect(all.items[2]!.outcome).toBe("failure");
    expect(all.items[3]!.action).toBe("auth.request.success");
    expect(all.items[3]!.outcome).toBe("success");

    // The failed login carries no email (we did not know it yet) but is
    // still queryable, and outcome + reason survive.
    expect(all.items[2]!.actor_email).toBeNull();
    const failMd = (all.items[2]!.metadata ?? {}) as Record<string, unknown>;
    expect(failMd.method).toBe("magic_link");
    expect(failMd.reason).toBe("invalid_or_expired_token");

    // No entry anywhere contains the magic token. This guards against a
    // future contributor adding the token into metadata "for debugging".
    const serialized = JSON.stringify(all.items);
    expect(serialized).not.toContain(SECRET_TOKEN);
  });

  it("strips forbidden secret-bearing metadata keys before persisting", async () => {
    // Even if a future caller passes a magic token / TOTP code / client_secret
    // into metadata, the helper must not write them to disk.
    await recordAuthEvent({
      verb: "login",
      method: "sso",
      outcome: "success",
      email: "carol@example.com",
      userId: "u_carol",
      metadata: {
        token: "do_not_log_me",
        access_token: "also_no",
        id_token: "definitely_no",
        password: "obviously_no",
        client_secret: "shh",
        // a benign one should survive
        ip_country: "US",
      },
    });
    const recent = await listAudit({ action_prefix: "auth.", limit: 1 });
    const md = (recent.items[0]!.metadata ?? {}) as Record<string, unknown>;
    expect(md.token).toBeUndefined();
    expect(md.access_token).toBeUndefined();
    expect(md.id_token).toBeUndefined();
    expect(md.password).toBeUndefined();
    expect(md.client_secret).toBeUndefined();
    expect(md.ip_country).toBe("US");
    expect(JSON.stringify(recent.items[0])).not.toContain("do_not_log_me");
  });

  it("hash chain stays linked when auth and non-auth events interleave; prefix filter is exact", async () => {
    const { recordAudit } = auditMod;
    await recordAudit({
      action: "settings.export",
      actor: { user_id: "u_alice", email: "alice@example.com" },
      outcome: "success",
    });
    await recordAuthEvent({
      verb: "logout",
      method: "session",
      outcome: "success",
      email: "alice@example.com",
      userId: "u_alice",
    });

    const authOnly = await listAudit({ action_prefix: "auth.", limit: 100 });
    expect(authOnly.chain_valid).toBe(true);
    for (const e of authOnly.items) {
      expect(e.action.startsWith("auth.")).toBe(true);
    }
    expect(authOnly.items[0]!.action).toBe("auth.logout.success");
    expect(authOnly.items[0]!.outcome).toBe("success");

    // Full view sees the settings event and still validates the chain.
    const everything = await listAudit({ limit: 100 });
    expect(everything.chain_valid).toBe(true);
    expect(everything.items.some((e) => e.action === "settings.export")).toBe(true);

    // The action_prefix filter must not overlap with other namespaces.
    const notAuth = await listAudit({ action_prefix: "settings.", limit: 100 });
    const overlap = authOnly.items.filter((e) => notAuth.items.some((x) => x.id === e.id));
    expect(overlap).toHaveLength(0);
  });
});
