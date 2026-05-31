/**
 * /v1/audit — key-authenticated dashboard audit export for SIEM tools.
 *
 * Exercises:
 *   1. Missing key (401)
 *   2. Invalid key (401)
 *   3. Valid key without `audit` scope (403, even with read+predict+webhooks)
 *   4. Valid `audit` key, JSON shape with chain_valid + tip_hash
 *   5. NDJSON format streams one entry per line + correct content-type
 *   6. CSV format escapes commas and includes the hash columns
 *   7. action filter narrows results
 *   8. tampered log surfaces chain_valid=false in body + header
 *   9. /v1/audit/verify returns tip hash, entries, and chain status without
 *      requiring read scope
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-v1-audit-"));

beforeAll(() => {
  process.env.ADHERENCE_DATA_DIR = tmp;
  process.env.ADHERENCE_FREE_DAILY_QUOTA = "1000";
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_FREE_DAILY_QUOTA;
});

const keys = await import("../lib/api-keys-store");
const audit = await import("../lib/dashboard-audit");
const route = await import("../app/v1/audit/route");
const verifyRoute = await import("../app/v1/audit/verify/route");

beforeEach(async () => {
  for (const f of ["api-keys.json", "usage.json", "dashboard-audit.jsonl"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
  audit._resetForTests();
});

function req(qs = "", headers: Record<string, string> = {}) {
  return new Request("http://test/v1/audit" + (qs ? "?" + qs : ""), {
    headers,
  }) as unknown as Parameters<typeof route.GET>[0];
}

function verifyReq(headers: Record<string, string> = {}) {
  return new Request("http://test/v1/audit/verify", {
    headers,
  }) as unknown as Parameters<typeof verifyRoute.GET>[0];
}

async function seed() {
  await audit.recordAudit({
    action: "settings.update",
    target: "policy:risk",
    actor: { user_id: "u_alice", email: "alice@acme.test" },
    metadata: { changed: ["threshold"] },
  });
  await audit.recordAudit({
    action: "key.rotate",
    target: "key:abc",
    actor: { user_id: "u_alice", email: "alice@acme.test" },
  });
  await audit.recordAudit({
    action: "account.erase",
    target: "user:u_bob",
    outcome: "denied",
    actor: { user_id: "u_admin", email: "admin@acme.test" },
    metadata: { reason: "not owner, fields contain a comma, and a \"quote\"" },
  });
}

describe("/v1/audit", () => {
  it("returns 401 when no key is presented", async () => {
    const res = await route.GET(req());
    expect(res.status).toBe(401);
  });

  it("returns 401 when the key is unknown", async () => {
    const res = await route.GET(
      req("", { authorization: "Bearer adh_does_not_exist" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the key lacks the 'audit' scope even with predict+read+webhooks", async () => {
    const { plaintext } = await keys.createKey("everything-but-audit", [
      "predict",
      "read",
      "webhooks",
    ]);
    const res = await route.GET(
      req("", { authorization: `Bearer ${plaintext}` }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      required_scope: string;
      key_scopes: string[];
    };
    expect(body.required_scope).toBe("audit");
    expect(body.key_scopes).not.toContain("audit");
  });

  it("returns 200 JSON with chain_valid, tip_hash, and the entries", async () => {
    await seed();
    const { plaintext } = await keys.createKey("siem-key", ["audit"]);
    const res = await route.GET(
      req("limit=10", { authorization: `Bearer ${plaintext}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Audit-Chain-Valid")).toBe("true");
    expect(res.headers.get("X-Audit-Tip-Hash")).toMatch(/^[a-f0-9]{64}$/);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("1000");
    const body = (await res.json()) as {
      items: Array<{ action: string; hash: string; prev_hash: string }>;
      total: number;
      chain_valid: boolean;
      tip_hash: string;
      returned: number;
    };
    expect(body.chain_valid).toBe(true);
    expect(body.total).toBe(3);
    expect(body.returned).toBe(3);
    // listAudit returns newest-first
    expect(body.items[0]!.action).toBe("account.erase");
    expect(body.items[2]!.action).toBe("settings.update");
    // hash chain wiring
    expect(body.tip_hash).toBe(body.items[0]!.hash);
  });

  it("streams NDJSON with the right content-type", async () => {
    await seed();
    const { plaintext } = await keys.createKey("siem-key", ["audit"]);
    const res = await route.GET(
      req("format=ndjson", { authorization: `Bearer ${plaintext}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
    expect(res.headers.get("content-disposition")).toMatch(/dashboard-audit/);
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("emits CSV with escaped quotes and commas and includes hash columns", async () => {
    await seed();
    const { plaintext } = await keys.createKey("siem-key", ["audit"]);
    const res = await route.GET(
      req("format=csv", { authorization: `Bearer ${plaintext}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const text = await res.text();
    const header = text.split("\n")[0]!;
    expect(header).toContain("hash");
    expect(header).toContain("prev_hash");
    expect(header).toContain("ts_iso");
    // the seeded denial metadata contains both a comma and an escaped quote
    expect(text).toContain('quote');
    expect(text).toMatch(/"\{""reason"":/);
  });

  it("filters by action", async () => {
    await seed();
    const { plaintext } = await keys.createKey("siem-key", ["audit"]);
    const res = await route.GET(
      req("action=key.rotate", { authorization: `Bearer ${plaintext}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ action: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]!.action).toBe("key.rotate");
  });

  it("surfaces chain_valid=false in body and header when the log is tampered with", async () => {
    await seed();
    // Corrupt the middle line in place: flip one character of `action`.
    const logPath = path.join(tmp, "dashboard-audit.jsonl");
    const raw = await fs.readFile(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const middle = JSON.parse(lines[1]!);
    middle.action = "key.rotate.TAMPERED";
    lines[1] = JSON.stringify(middle);
    await fs.writeFile(logPath, lines.join("\n") + "\n");
    audit._resetForTests();

    const { plaintext } = await keys.createKey("siem-key", ["audit"]);
    const res = await route.GET(
      req("", { authorization: `Bearer ${plaintext}` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Audit-Chain-Valid")).toBe("false");
    const body = (await res.json()) as { chain_valid: boolean };
    expect(body.chain_valid).toBe(false);
  });
});

describe("/v1/audit/verify", () => {
  it("returns 401 without a key", async () => {
    const res = await verifyRoute.GET(verifyReq());
    expect(res.status).toBe(401);
  });

  it("returns 403 without the 'audit' scope", async () => {
    const { plaintext } = await keys.createKey("read-only", ["read"]);
    const res = await verifyRoute.GET(
      verifyReq({ authorization: `Bearer ${plaintext}` }),
    );
    expect(res.status).toBe(403);
  });

  it("returns the tip hash and entry count with chain_valid=true", async () => {
    await seed();
    const { plaintext } = await keys.createKey("siem-key", ["audit"]);
    const res = await verifyRoute.GET(
      verifyReq({ authorization: `Bearer ${plaintext}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chain_valid: boolean;
      tip_hash: string;
      entries: number;
      checked_at: string;
    };
    expect(body.chain_valid).toBe(true);
    expect(body.tip_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.entries).toBe(3);
    expect(() => new Date(body.checked_at)).not.toThrow();
  });
});
