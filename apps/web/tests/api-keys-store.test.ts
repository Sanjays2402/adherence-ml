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

  it("rotates a key: old plaintext stops verifying, new one works, metadata is preserved", async () => {
    const created = await store.createKey("prod backend");
    // bump usage so we can confirm continuity through rotation.
    await store.verifyKey(created.plaintext);
    await store.verifyKey(created.plaintext);

    const rotated = await store.rotateKey(created.record.id);
    expect(rotated).not.toBeNull();
    expect(rotated!.plaintext).toMatch(/^adh_/);
    expect(rotated!.plaintext).not.toBe(created.plaintext);
    expect(rotated!.record.id).toBe(created.record.id);
    expect(rotated!.record.name).toBe("prod backend");
    expect(rotated!.record.use_count).toBe(2);
    expect(rotated!.record.prefix).toBe(rotated!.plaintext.slice(0, 12));
    expect(rotated!.record.rotated_at).toBeTypeOf("number");

    // Old secret no longer authenticates.
    expect(await store.verifyKey(created.plaintext)).toBeNull();
    // New secret does, and increments the preserved counter.
    const v = await store.verifyKey(rotated!.plaintext);
    expect(v).not.toBeNull();
    expect(v!.use_count).toBe(3);
  });

  it("rotateKey returns null for unknown or revoked keys", async () => {
    expect(await store.rotateKey("does-not-exist")).toBeNull();
    const { record } = await store.createKey("will-revoke");
    await store.revokeKey(record.id);
    expect(await store.rotateKey(record.id)).toBeNull();
  });

  it("createKey persists requested scopes and hasScope enforces them", async () => {
    const onlyPredict = await store.createKey("backend", ["predict"]);
    expect(store.scopesOf(onlyPredict.record)).toEqual(["predict"]);
    expect(store.hasScope(onlyPredict.record, "predict")).toBe(true);
    expect(store.hasScope(onlyPredict.record, "read")).toBe(false);

    const both = await store.createKey("dashboard", ["read", "predict"]);
    // canonical order is preserved regardless of input order
    expect(store.scopesOf(both.record)).toEqual(["predict", "read"]);
  });

  it("normalizeScopes drops unknown values and falls back to defaults when empty", () => {
    expect(store.normalizeScopes(["predict", "bogus"])).toEqual(["predict"]);
    expect(store.normalizeScopes([])).toEqual([...store.DEFAULT_SCOPES]);
    expect(store.normalizeScopes("not-an-array" as unknown)).toEqual([...store.DEFAULT_SCOPES]);
  });

  it("legacy records without a scopes field still authenticate with default scopes", async () => {
    // simulate a key issued before scopes existed by writing the store by hand
    const plaintext = "adh_legacyTESTkey_____________________";
    const hash = (await import("node:crypto"))
      .createHash("sha256")
      .update(plaintext)
      .digest("hex");
    const file = path.join(tmp, "api-keys.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        keys: [
          {
            id: "legacy1",
            name: "legacy",
            prefix: plaintext.slice(0, 12),
            hash,
            created_at: Date.now(),
            last_used_at: null,
            use_count: 0,
            revoked: false,
          },
        ],
      }),
      "utf8",
    );
    const v = await store.verifyKey(plaintext);
    expect(v).not.toBeNull();
    expect(store.scopesOf(v!)).toEqual([...store.DEFAULT_SCOPES]);
    expect(store.hasScope(v!, "predict")).toBe(true);
    expect(store.hasScope(v!, "read")).toBe(true);
  });
});
