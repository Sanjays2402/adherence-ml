/**
 * Tests for API key revocation reason capture.
 *
 * Enterprise / SOC2 reviewers want to see, for every credential, *why* it
 * was killed. These tests pin the contract:
 *
 *   - revokeKeyDetailed records reason, note, actor, and revoked_at
 *   - publicView surfaces the new revocation metadata
 *   - double-revoke returns `already_revoked` (so the API can return 409
 *     instead of pretending the second attempt did something)
 *   - notes longer than the cap are truncated, not rejected silently
 *   - unknown reasons fall back to `unspecified` (defensive: never trust
 *     callers to enumerate the enum)
 *   - SELECTABLE_REVOKE_REASONS never advertises `unspecified` to a UI,
 *     so the dashboard cannot accidentally let a human pick the legacy
 *     placeholder.
 *
 * Uses a throwaway ADHERENCE_DATA_DIR so it cannot contaminate the other
 * api-keys-store tests in the same package.
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterAll } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "api-keys-revoke-reason-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const store = await import("../lib/api-keys-store");

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe("api-keys-store revocation reasons", () => {
  it("revokeKeyDetailed captures reason, note, actor, and timestamp", async () => {
    const { record } = await store.createKey("integration-A");
    const before = Date.now();
    const result = await store.revokeKeyDetailed(record.id, {
      reason: "compromised",
      note: "found in a public gist",
      actor: { user_id: "u-1", email: "alice@example.com" },
    });
    expect(result.status).toBe("revoked");
    expect(result.ok).toBe(true);
    expect(result.before?.revoked).toBe(false);
    expect(result.after?.revoked).toBe(true);
    expect(result.after?.revoked_reason).toBe("compromised");
    expect(result.after?.revoked_note).toBe("found in a public gist");
    expect(result.after?.revoked_by_user_id).toBe("u-1");
    expect(result.after?.revoked_by_email).toBe("alice@example.com");
    expect(typeof result.after?.revoked_at).toBe("number");
    expect(result.after!.revoked_at!).toBeGreaterThanOrEqual(before);
  });

  it("publicView exposes revocation metadata so the dashboard can render it", async () => {
    const { record } = await store.createKey("integration-B");
    await store.revokeKeyDetailed(record.id, {
      reason: "employee_offboarded",
      note: "carol left 2026-05-30",
      actor: { user_id: "u-2", email: "ops@example.com" },
    });
    const all = await store.listKeys();
    const me = all.find((k) => k.id === record.id)!;
    const view = store.publicView(me) as Record<string, unknown>;
    expect(view.revoked).toBe(true);
    expect(view.revoked_reason).toBe("employee_offboarded");
    expect(view.revoked_note).toBe("carol left 2026-05-30");
    expect(view.revoked_by_email).toBe("ops@example.com");
    expect(typeof view.revoked_at).toBe("number");
  });

  it("double-revoke returns already_revoked instead of silently flipping again", async () => {
    const { record } = await store.createKey("integration-C");
    const first = await store.revokeKeyDetailed(record.id, { reason: "rotated" });
    expect(first.status).toBe("revoked");
    const firstRevokedAt = first.after?.revoked_at;
    const second = await store.revokeKeyDetailed(record.id, {
      reason: "compromised",
      note: "should not overwrite the first reason",
    });
    expect(second.status).toBe("already_revoked");
    expect(second.ok).toBe(false);
    // The before/after snapshots show the first revoke is untouched.
    expect(second.before?.revoked_reason).toBe("rotated");
    expect(second.after?.revoked_reason).toBe("rotated");
    expect(second.after?.revoked_at).toBe(firstRevokedAt);
    expect(second.after?.revoked_note).toBeNull();
  });

  it("revokeKey(id) keeps its boolean contract for legacy callers", async () => {
    const { record } = await store.createKey("integration-D");
    const ok = await store.revokeKey(record.id);
    expect(ok).toBe(true);
    const again = await store.revokeKey(record.id);
    expect(again).toBe(false);
  });

  it("notes longer than REVOKE_NOTE_MAX are truncated, not rejected", async () => {
    const { record } = await store.createKey("integration-E");
    const long = "x".repeat(store.REVOKE_NOTE_MAX + 50);
    const result = await store.revokeKeyDetailed(record.id, {
      reason: "other",
      note: long,
    });
    expect(result.status).toBe("revoked");
    expect(result.after?.revoked_note?.length).toBe(store.REVOKE_NOTE_MAX);
  });

  it("unknown reasons fall back to 'unspecified' rather than persisting garbage", async () => {
    const { record } = await store.createKey("integration-F");
    const result = await store.revokeKeyDetailed(record.id, {
      // @ts-expect-error: intentionally pass an off-enum value to prove the guard
      reason: "totally_made_up",
    });
    expect(result.status).toBe("revoked");
    expect(result.after?.revoked_reason).toBe("unspecified");
  });

  it("SELECTABLE_REVOKE_REASONS never advertises the legacy 'unspecified' bucket", () => {
    expect(store.SELECTABLE_REVOKE_REASONS).not.toContain("unspecified");
    // Whatever else changes, the most-critical bucket must stay selectable.
    expect(store.SELECTABLE_REVOKE_REASONS).toContain("compromised");
  });

  it("normalizeRevokeNote strips empties and trims", () => {
    expect(store.normalizeRevokeNote(undefined)).toBeNull();
    expect(store.normalizeRevokeNote(null)).toBeNull();
    expect(store.normalizeRevokeNote("")).toBeNull();
    expect(store.normalizeRevokeNote("   ")).toBeNull();
    expect(store.normalizeRevokeNote("  hi  ")).toBe("hi");
    expect(store.normalizeRevokeNote(123 as unknown)).toBeNull();
  });
});
