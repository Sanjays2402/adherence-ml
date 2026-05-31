import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "kttl-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("workspace api_key_max_ttl_days policy", () => {
  it("normalizes and persists the cap, defaulting to null", async () => {
    const ws = await import("../lib/workspaces-store");
    expect(ws.normalizeApiKeyMaxTtlDays(null)).toBeNull();
    expect(ws.normalizeApiKeyMaxTtlDays(0)).toBeNull();
    expect(ws.normalizeApiKeyMaxTtlDays(-5)).toBeNull();
    expect(ws.normalizeApiKeyMaxTtlDays(90)).toBe(90);
    expect(ws.normalizeApiKeyMaxTtlDays(99999)).toBe(ws.API_KEY_TTL_MAX_DAYS);
    expect(ws.normalizeApiKeyMaxTtlDays("30")).toBe(30);
    expect(ws.normalizeApiKeyMaxTtlDays("garbage")).toBeNull();
  });

  it("setWorkspacePolicy round-trips the cap (owner only)", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    const after = await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 45,
    });
    expect(after.api_key_max_ttl_days).toBe(45);

    // Persists across read.
    const reread = await ws.getWorkspacePolicy(wsA.id);
    expect(reread?.api_key_max_ttl_days).toBe(45);

    // Non-owner cannot set it (RBAC).
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
    const ws = await import("../lib/workspaces-store");
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
    // Strictest wins.
    expect(await ws.effectiveApiKeyMaxTtlDays()).toBe(30);
  });

  it("POST /api/keys rejects keys that never expire when a cap is set", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 90,
    });
    const { POST } = await import("../app/api/keys/route");
    const reqNoTtl = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "forever-key" }),
    }) as unknown as import("next/server").NextRequest;
    const res = await POST(reqNoTtl);
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe("api_key_ttl_required");
    expect(j.max_ttl_days).toBe(90);
  });

  it("POST /api/keys rejects ttl_days greater than the cap", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 30,
    });
    const { POST } = await import("../app/api/keys/route");
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "too-long", ttl_days: 365 }),
    }) as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe("api_key_ttl_exceeds_cap");
  });

  it("POST /api/keys accepts a TTL within the cap", async () => {
    const ws = await import("../lib/workspaces-store");
    const [wsA] = await ws.listForUser("u_alice", "alice@example.com");
    await ws.setWorkspacePolicy(wsA.id, "u_alice", {
      session_max_age_minutes: null,
      require_mfa: false,
      api_key_max_ttl_days: 90,
    });
    const { POST } = await import("../app/api/keys/route");
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "good", ttl_days: 30 }),
    }) as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(typeof j.key).toBe("string");
    expect(j.expires_at).toBeGreaterThan(Date.now());
  });

  it("POST /api/keys still accepts no-ttl when no cap is configured (back-compat)", async () => {
    const { POST } = await import("../app/api/keys/route");
    const req = new Request("http://localhost/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "legacy" }),
    }) as unknown as import("next/server").NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.expires_at).toBeNull();
  });

  it("rotateKey re-stamps expires_at when a cap is supplied", async () => {
    const store = await import("../lib/api-keys-store");
    const { record } = await store.createKey("rotating", undefined, null, null);
    expect(record.expires_at).toBeNull();
    const before = Date.now();
    const issued = await store.rotateKey(record.id, { capTtlDays: 30 });
    expect(issued).not.toBeNull();
    const expectedMax = before + 31 * 24 * 60 * 60 * 1000;
    const expectedMin = before + 29 * 24 * 60 * 60 * 1000;
    expect(issued!.record.expires_at).toBeGreaterThan(expectedMin);
    expect(issued!.record.expires_at).toBeLessThan(expectedMax);
  });
});
