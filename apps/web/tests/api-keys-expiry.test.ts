/**
 * Smoke test for api-keys-store expiry semantics.
 *
 * Verifies:
 *   1. ttlToExpiresAt maps days -> a future epoch-ms and rejects junk (null/0/neg/NaN).
 *   2. createKey with an expiresAt persists the value and the key verifies immediately.
 *   3. A key whose expires_at has passed is treated as inert: verifyKey returns null,
 *      rotateKey returns null. Behaviour matches a revoked key.
 *   4. A key with expires_at = null (never expires) keeps working.
 *
 * Uses a throwaway ADHERENCE_DATA_DIR so it never touches real data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterAll } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "api-keys-expiry-"));
process.env.ADHERENCE_DATA_DIR = tmp;

// Dynamic import so the env var is read on module init.
const store = await import("../lib/api-keys-store");

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe("api-keys-store expiry", () => {
  it("ttlToExpiresAt converts positive day counts and rejects non-positive / non-finite", () => {
    const now = 1_700_000_000_000;
    expect(store.ttlToExpiresAt(7, now)).toBe(now + 7 * 24 * 60 * 60 * 1000);
    expect(store.ttlToExpiresAt(null, now)).toBeNull();
    expect(store.ttlToExpiresAt(0, now)).toBeNull();
    expect(store.ttlToExpiresAt(-5, now)).toBeNull();
    expect(store.ttlToExpiresAt(Number.NaN, now)).toBeNull();
    // capped at 10 years
    const capped = store.ttlToExpiresAt(100_000, now);
    expect(capped).toBe(now + 3650 * 24 * 60 * 60 * 1000);
  });

  it("isExpired returns false for null/future and true for past", () => {
    const now = 1_700_000_000_000;
    expect(store.isExpired({ expires_at: null }, now)).toBe(false);
    expect(store.isExpired({ expires_at: undefined }, now)).toBe(false);
    expect(store.isExpired({ expires_at: now + 1000 }, now)).toBe(false);
    expect(store.isExpired({ expires_at: now - 1 }, now)).toBe(true);
  });

  it("a freshly created key with a future expiry verifies and exposes expires_at", async () => {
    const future = Date.now() + 60_000;
    const issued = await store.createKey("future-key", ["read"], future);
    expect(issued.record.expires_at).toBe(future);
    const verified = await store.verifyKey(issued.plaintext);
    expect(verified).not.toBeNull();
    expect(verified?.id).toBe(issued.record.id);
    expect(verified?.expires_at).toBe(future);
  });

  it("an already-expired key is rejected by verifyKey and rotateKey", async () => {
    const past = Date.now() - 60_000;
    const issued = await store.createKey("expired-key", ["read"], past);
    const verified = await store.verifyKey(issued.plaintext);
    expect(verified).toBeNull();
    const rotated = await store.rotateKey(issued.record.id);
    expect(rotated).toBeNull();
  });

  it("a key with no expiry (null) keeps working", async () => {
    const issued = await store.createKey("no-expiry", ["read"], null);
    expect(issued.record.expires_at).toBeNull();
    const verified = await store.verifyKey(issued.plaintext);
    expect(verified).not.toBeNull();
  });
});
