/**
 * /v1/keys/me — read-only key introspection. Exercises the four interesting
 * branches: missing key, invalid key, missing scope, success.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-keysme-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/api-keys-store");
const route = await import("../app/v1/keys/me/route");

function req(headers: Record<string, string> = {}) {
  return new Request("http://test/v1/keys/me", { headers }) as unknown as Parameters<
    typeof route.GET
  >[0];
}

beforeEach(async () => {
  const f = path.join(tmp, "api-keys.json");
  if (existsSync(f)) await fs.rm(f);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("/v1/keys/me", () => {
  it("returns 401 when no key is presented", async () => {
    const res = await route.GET(req());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/missing api key/i);
  });

  it("returns 401 when the key is unknown", async () => {
    const res = await route.GET(req({ authorization: "Bearer adh_does_not_exist" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the key is valid but lacks the 'read' scope", async () => {
    const { plaintext } = await store.createKey("predict-only", ["predict"]);
    const res = await route.GET(req({ authorization: `Bearer ${plaintext}` }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      detail: string;
      key_scopes: string[];
      required_scope: string;
    };
    expect(body.required_scope).toBe("read");
    expect(body.key_scopes).toEqual(["predict"]);
  });

  it("returns 200 with sanitised key metadata when the read scope is present", async () => {
    const { record, plaintext } = await store.createKey("read-key", ["read"]);
    // hit it twice so use_count reflects a real call
    await route.GET(req({ "x-api-key": plaintext }));
    const res = await route.GET(req({ authorization: `Bearer ${plaintext}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      prefix: string;
      scopes: string[];
      use_count: number;
      last_used_at: number | null;
    };
    expect(body.id).toBe(record.id);
    expect(body.prefix).toBe(record.prefix);
    expect(body.scopes).toEqual(["read"]);
    expect(body.use_count).toBeGreaterThanOrEqual(2);
    expect(body.last_used_at).not.toBeNull();
    // never leak hash or plaintext in the response
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toMatch(/hash/i);
  });
});
