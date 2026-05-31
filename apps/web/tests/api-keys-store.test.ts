import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-keys-"));
process.env.ADHERENCE_DATA_DIR = tmp;

// import AFTER env is set so the module-level DATA_DIR resolves to tmp
const store = await import("../lib/api-keys-store");

beforeEach(async () => {
  const f = path.join(tmp, "api-keys.json");
  if (existsSync(f)) await fs.rm(f);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("api-keys-store", () => {
  it("creates a key, returns plaintext once, persists only a hash", async () => {
    const { record, plaintext } = await store.createKey("prod backend");
    expect(plaintext).toMatch(/^adh_/);
    expect(record.name).toBe("prod backend");
    expect(record.prefix).toBe(plaintext.slice(0, 12));
    expect(record.revoked).toBe(false);

    const raw = await fs.readFile(path.join(tmp, "api-keys.json"), "utf8");
    expect(raw).not.toContain(plaintext);
    expect(raw).toContain(record.prefix);
  });

  it("verifies a valid key, rejects an unknown one, and tracks usage", async () => {
    const { plaintext } = await store.createKey("k1");
    const ok = await store.verifyKey(plaintext);
    expect(ok).not.toBeNull();
    expect(ok!.use_count).toBe(1);
    expect(ok!.last_used_at).not.toBeNull();

    const ok2 = await store.verifyKey(plaintext);
    expect(ok2!.use_count).toBe(2);

    const bad = await store.verifyKey("adh_not_a_real_key");
    expect(bad).toBeNull();
  });

  it("revoked keys no longer verify", async () => {
    const { record, plaintext } = await store.createKey("k2");
    await store.revokeKey(record.id);
    const v = await store.verifyKey(plaintext);
    expect(v).toBeNull();
  });

  it("extractKey reads Authorization and x-api-key", () => {
    const h1 = new Headers({ authorization: "Bearer abc123" });
    expect(store.extractKey(h1)).toBe("abc123");
    const h2 = new Headers({ "x-api-key": "xyz" });
    expect(store.extractKey(h2)).toBe("xyz");
    expect(store.extractKey(new Headers())).toBeNull();
  });
});
