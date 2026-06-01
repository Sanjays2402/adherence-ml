/**
 * Enterprise dry-run mode test.
 *
 * Proves that ?dry_run=true on a destructive route returns a preview AND
 * does NOT mutate state. The corresponding live call (no dry_run) then
 * does mutate state. Regression-tests the contract the entire dry-run
 * helper exists to enforce.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-dryrun-"));
process.env.ADHERENCE_DATA_DIR = tmp;
// Bypass signed-session auth so the route handler's dry-run + step-up
// gates can be exercised with plain Request objects.
process.env.ADHERENCE_DASHBOARD_OPEN = "1";

const store = await import("../lib/api-keys-store");
const route = await import("../app/api/keys/[id]/route");
const dr = await import("../lib/dry-run");

beforeEach(async () => {
  const f = path.join(tmp, "api-keys.json");
  if (existsSync(f)) await fs.rm(f);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

function makeReq(url: string, init: RequestInit = {}) {
  // The route uses NextRequest features (.nextUrl etc.), but its dry-run
  // path only reads url + headers, both supplied by the Web Request API.
  return new Request(url, init) as unknown as import("next/server").NextRequest;
}

describe("dry-run helper", () => {
  it("detects ?dry_run= truthy values", () => {
    for (const v of ["true", "1", "yes", "on", "TRUE"]) {
      expect(dr.isDryRun(makeReq(`http://x/?dry_run=${v}`))).toBe(true);
    }
    expect(dr.isDryRun(makeReq("http://x/"))).toBe(false);
    expect(dr.isDryRun(makeReq("http://x/?dry_run=false"))).toBe(false);
  });

  it("detects X-Dry-Run header", () => {
    expect(
      dr.isDryRun(makeReq("http://x/", { headers: { "x-dry-run": "true" } })),
    ).toBe(true);
    expect(
      dr.isDryRun(makeReq("http://x/", { headers: { "x-dry-run": "no" } })),
    ).toBe(false);
  });
});

describe("DELETE /api/keys/:id dry-run", () => {
  it("returns a preview and does not revoke the key", async () => {
    const { record } = await store.createKey("preview-target");
    expect(record.revoked).toBe(false);

    const res = await route.DELETE(
      makeReq(`http://x/api/keys/${record.id}?dry_run=true`, { method: "DELETE" }),
      { params: Promise.resolve({ id: record.id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-dry-run")).toBe("true");
    const body = await res.json();
    expect(body.dry_run).toBe(true);
    expect(body.would).toBe("delete");
    expect(body.preview.resource).toBe("api_key");
    expect(body.preview.id).toBe(record.id);
    expect(body.preview.summary).toMatch(/revoke API key/);

    // State must be unchanged.
    const after = (await store.listKeys()).find((k) => k.id === record.id);
    expect(after).toBeTruthy();
    expect(after!.revoked).toBe(false);
  });

  it("the real call without dry-run actually revokes the key", async () => {
    const { record } = await store.createKey("live-target");
    const res = await route.DELETE(
      makeReq(`http://x/api/keys/${record.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: record.id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-dry-run")).toBeNull();
    const after = (await store.listKeys()).find((k) => k.id === record.id);
    expect(after!.revoked).toBe(true);
  });

  it("returns 404 for an unknown key even in dry-run mode", async () => {
    const res = await route.DELETE(
      makeReq("http://x/api/keys/does-not-exist?dry_run=true", { method: "DELETE" }),
      { params: Promise.resolve({ id: "does-not-exist" }) },
    );
    expect(res.status).toBe(404);
  });
});
