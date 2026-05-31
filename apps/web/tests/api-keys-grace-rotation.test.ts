import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-keys-grace-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/api-keys-store");

beforeEach(async () => {
  const f = path.join(tmp, "api-keys.json");
  if (existsSync(f)) await fs.rm(f);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("api-keys grace rotation", () => {
  it("hard-cutover rotation (grace=0) immediately invalidates the old secret", async () => {
    const { record, plaintext: old } = await store.createKey("ci");
    const rotated = await store.rotateKey(record.id, 0);
    expect(rotated).not.toBeNull();
    expect(rotated!.plaintext).not.toBe(old);
    expect(await store.verifyKey(old)).toBeNull();
    expect((await store.verifyKey(rotated!.plaintext))?.id).toBe(record.id);
    const list = await store.listKeys();
    expect(list[0].previous_hash ?? null).toBeNull();
    expect(store.hasActiveGrace(list[0])).toBe(false);
  });

  it("grace rotation keeps the old secret valid until the window closes", async () => {
    const { record, plaintext: old } = await store.createKey("prod");
    const rotated = await store.rotateKey(record.id, 60); // 1h grace
    expect(rotated).not.toBeNull();
    const list = await store.listKeys();
    const k = list.find((x) => x.id === record.id)!;
    expect(store.hasActiveGrace(k)).toBe(true);
    expect(k.previous_expires_at!).toBeGreaterThan(Date.now());

    // New secret works, marked as primary
    const fresh = await store.verifyKeyDetailed(rotated!.plaintext);
    expect(fresh?.viaGrace).toBe(false);

    // Old secret still works, flagged as via_grace
    const grace = await store.verifyKeyDetailed(old);
    expect(grace?.viaGrace).toBe(true);
    expect(grace?.record.id).toBe(record.id);
  });

  it("revokePreviousSecret immediately ends an active grace window", async () => {
    const { record, plaintext: old } = await store.createKey("prod");
    await store.rotateKey(record.id, 60);
    expect(await store.verifyKey(old)).not.toBeNull();

    const updated = await store.revokePreviousSecret(record.id);
    expect(updated).not.toBeNull();
    expect(updated!.previous_hash ?? null).toBeNull();
    expect(await store.verifyKey(old)).toBeNull();
  });

  it("revokePreviousSecret returns null when there is no active grace", async () => {
    const { record } = await store.createKey("ci");
    const r = await store.revokePreviousSecret(record.id);
    expect(r).toBeNull();
  });

  it("publicView hides previous_prefix once the grace window has elapsed", async () => {
    const { record } = await store.createKey("ci");
    // Force a tiny grace and let it elapse by manually rewriting the file
    await store.rotateKey(record.id, 60);
    const file = path.join(tmp, "api-keys.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.keys[0].previous_expires_at = Date.now() - 1000;
    await fs.writeFile(file, JSON.stringify(raw));
    const list = await store.listKeys();
    const view = store.publicView(list[0]);
    expect(view.grace_active).toBe(false);
    expect(view.previous_prefix).toBeNull();
  });

  it("normalizeGraceMinutes clamps, defaults, and floors", async () => {
    expect(store.normalizeGraceMinutes(0)).toBe(0);
    expect(store.normalizeGraceMinutes(null)).toBe(0);
    expect(store.normalizeGraceMinutes(undefined)).toBe(0);
    expect(store.normalizeGraceMinutes(-5)).toBe(0);
    expect(store.normalizeGraceMinutes(90.7)).toBe(90);
    expect(store.normalizeGraceMinutes(1e9)).toBe(store.MAX_GRACE_MINUTES);
  });

  it("rotating a key with an existing grace window replaces (not stacks) the previous secret", async () => {
    const { record, plaintext: v1 } = await store.createKey("ci");
    const r2 = await store.rotateKey(record.id, 60);
    const r3 = await store.rotateKey(record.id, 60);
    // v1 should no longer be valid; only the most-recent previous (v2) is the grace secret
    expect(await store.verifyKey(v1)).toBeNull();
    expect((await store.verifyKeyDetailed(r2!.plaintext))?.viaGrace).toBe(true);
    expect((await store.verifyKeyDetailed(r3!.plaintext))?.viaGrace).toBe(false);
  });
});
