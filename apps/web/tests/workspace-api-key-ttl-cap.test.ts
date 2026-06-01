import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "kttl-"));
process.env.ADHERENCE_DATA_DIR = tmp;
// These tests exercise the route handlers directly with plain Request
// objects; the dashboard-open flag bypasses the signed-session check so
// the policy-validation logic under test still gets exercised.
process.env.ADHERENCE_DASHBOARD_OPEN = "1";

// import AFTER env is set so module-level DATA_DIR resolves to tmp
const ws = await import("../lib/workspaces-store");
const keysStore = await import("../lib/api-keys-store");
const keysRoute = await import("../app/api/keys/route");

beforeEach(async () => {
  // wipe both persisted stores between tests so each one is hermetic
  for (const name of ["workspaces.json", "api-keys.json"]) {
    const f = path.join(tmp, name);
    if (existsSync(f)) await fs.rm(f);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("workspace api_key_max_ttl_days policy", () => {
  it("normalizes and persists the cap, defaulting to null", () => {
    expect(ws.normalizeApiKeyMaxTtlDays(null)).toBeNull();
    expect(ws.normalizeApiKeyMaxTtlDays(0)).toBeNull();
    expect(ws.normalizeApiKeyMaxTtlDays(-5)).toBeNull();
    expect(ws.normalizeApiKeyMaxTtlDays(90)).toBe(90);
    expect(ws.normalizeApiKeyMaxTtlDays(99999)).toBe(ws.API_KEY_TTL_MAX_DAYS);
    expect(ws.normalizeApiKeyMaxTtlDays("30")).toBe(30);
    expect(ws.normalizeApiKeyMaxTtlDays("garbage")).toBeNull();
  });

  it("setWorkspacePolicy round-trips the cap (owner only)", async () => {
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const after = await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 45,
    });
    expect(after.api_key_max_ttl_days).toBe(45);

    const reread = await ws.getWorkspacePolicy(wsA.id);
    expect(reread?.api_key_max_ttl_days).toBe(45);

    const bob = await ws.provisionMember(wsA.id, "bob@example.com", "editor");
    await expect(
      ws.setWorkspacePolicy(wsA.id, bob.user_id, {
        session_max_age_minutes: null,
        require_mfa: false,
        api_key_max_ttl_days: 10,
      }),
    ).rejects.toThrow(/owner only/);
  });

  it("effectiveApiKeyMaxTtlDays picks the strictest cap across workspaces", async () => {
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const [wsB] = await ws.listForUser("u_bob", "bob@example.com");
    expect(await ws.effectiveApiKeyMaxTtlDays()).toBeNull();
    await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 365,
    });
    expect(await ws.effectiveApiKeyMaxTtlDays()).toBe(365);
    await ws.setWorkspacePolicy(wsB.id, "u_bob", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 30,
    });
    expect(await ws.effectiveApiKeyMaxTtlDays()).toBe(30);
  });

  it("POST /api/keys rejects keys that never expire when a cap is set", async () => {
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 90,
    });
    const reqNoTtl = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "forever-key" }),
    }) as unknown as import("next/server").NextRequest;
    const res = await keysRoute.POST(reqNoTtl);
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe("api_key_ttl_required");
    expect(j.max_ttl_days).toBe(90);
  });

  it("POST /api/keys rejects ttl_days greater than the cap", async () => {
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 30,
    });
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "too-long", ttl_days: 365 }),
    }) as unknown as import("next/server").NextRequest;
    const res = await keysRoute.POST(req);
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe("api_key_ttl_exceeds_cap");
  });

  it("POST /api/keys accepts a TTL within the cap", async () => {
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 90,
    });
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "good", ttl_days: 30 }),
    }) as unknown as import("next/server").NextRequest;
    const res = await keysRoute.POST(req);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(typeof j.key).toBe("string");
    expect(j.expires_at).toBeGreaterThan(Date.now());
  });

  it("POST /api/keys still accepts no-ttl when no cap is configured (back-compat)", async () => {
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "legacy" }),
    }) as unknown as import("next/server").NextRequest;
    const res = await keysRoute.POST(req);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.expires_at).toBeNull();
  });

  it("rotateKey re-stamps expires_at when a cap is supplied", async () => {
    const { record } = await keysStore.createKey("rotating", undefined, null, null);
    expect(record.expires_at).toBeNull();
    const before = Date.now();
    const issued = await keysStore.rotateKey(record.id, { capTtlDays: 30 });
    expect(issued).not.toBeNull();
    const expiresAt = issued!.record.expires_at as number;
    expect(typeof expiresAt).toBe("number");
    const expectedMax = before + 31 * 24 * 60 * 60 * 1000;
    const expectedMin = before + 29 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(expectedMin);
    expect(expiresAt).toBeLessThan(expectedMax);
  });
});
