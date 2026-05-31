/**
 * /v1/keys/me/rotate — self-service API key rotation.
 *
 * Proves:
 *   - 401 when no key is presented
 *   - 401 when the key is unknown or revoked
 *   - 400 when the confirm field is missing or false
 *   - 200 on success, with a new plaintext that verifies, and the
 *     old plaintext no longer verifying (atomic swap)
 *   - same id and scopes are preserved, rotated_at is set
 *   - the response never leaks the hash
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-keysrot-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/api-keys-store");
const route = await import("../app/v1/keys/me/rotate/route");

function req(headers: Record<string, string> = {}, body: unknown = { confirm: true }) {
  return new Request("http://test/v1/keys/me/rotate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as Parameters<typeof route.POST>[0];
}

beforeEach(async () => {
  const f = path.join(tmp, "api-keys.json");
  if (existsSync(f)) await fs.rm(f);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("/v1/keys/me/rotate", () => {
  it("returns 401 when no key is presented", async () => {
    const res = await route.POST(req({}, { confirm: true }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the key is unknown", async () => {
    const res = await route.POST(
      req({ authorization: "Bearer adh_does_not_exist" }, { confirm: true }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the key has been revoked", async () => {
    const { record, plaintext } = await store.createKey("revoked-key", ["read"]);
    await store.revokeKey(record.id);
    const res = await route.POST(
      req({ authorization: `Bearer ${plaintext}` }, { confirm: true }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when confirm is missing or false", async () => {
    const { plaintext } = await store.createKey("confirm-test", ["read"]);
    const r1 = await route.POST(req({ authorization: `Bearer ${plaintext}` }, {}));
    expect(r1.status).toBe(400);
    const r2 = await route.POST(
      req({ authorization: `Bearer ${plaintext}` }, { confirm: false }),
    );
    expect(r2.status).toBe(400);
  });

  it("rotates atomically: new key verifies, old key does not", async () => {
    const { record, plaintext: oldPlain } = await store.createKey("rotate-me", [
      "read",
      "predict",
    ]);
    const res = await route.POST(
      req({ authorization: `Bearer ${oldPlain}` }, { confirm: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      key: string;
      prefix: string;
      scopes: string[];
      rotated_at: number | null;
      use_count: number;
    };
    expect(body.id).toBe(record.id);
    expect(body.scopes).toEqual(["predict", "read"]);
    expect(typeof body.key).toBe("string");
    expect(body.key.startsWith("adh_")).toBe(true);
    expect(body.key).not.toBe(oldPlain);
    expect(body.rotated_at).not.toBeNull();

    // new plaintext verifies and resolves to the same record id
    const verifiedNew = await store.verifyKey(body.key);
    expect(verifiedNew?.id).toBe(record.id);

    // old plaintext is dead
    const verifiedOld = await store.verifyKey(oldPlain);
    expect(verifiedOld).toBeNull();

    // never leak the hash
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/"hash"/);

    // standard rate-limit headers present
    expect(res.headers.get("x-ratelimit-limit")).not.toBeNull();
    expect(res.headers.get("x-ratelimit-remaining")).not.toBeNull();
    expect(res.headers.get("x-ratelimit-reset")).not.toBeNull();
  });
});
