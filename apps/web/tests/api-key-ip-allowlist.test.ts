/**
 * Per-key client IP allowlist: validates CIDR parsing, IPv4/IPv6 matching,
 * fail-closed behavior when the client IP is unknown, and the end-to-end
 * gate via the api-keys-store helpers used by every /v1/* route.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-keyip-"));
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

describe("normalizeCidr", () => {
  it("accepts bare IPv4 and forces /32", () => {
    expect(store.normalizeCidr("203.0.113.7")).toBe("203.0.113.7/32");
  });
  it("accepts IPv4 with /N", () => {
    expect(store.normalizeCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(store.normalizeCidr("192.168.1.0/24")).toBe("192.168.1.0/24");
  });
  it("rejects malformed IPv4", () => {
    expect(store.normalizeCidr("999.0.0.1")).toBeNull();
    expect(store.normalizeCidr("10.0.0")).toBeNull();
    expect(store.normalizeCidr("10.0.0.0/33")).toBeNull();
    expect(store.normalizeCidr("not-an-ip")).toBeNull();
  });
  it("accepts bare IPv6 and forces /128", () => {
    expect(store.normalizeCidr("2001:db8::1")).toBe("2001:db8::1/128");
  });
  it("accepts IPv6 with /N", () => {
    expect(store.normalizeCidr("2001:db8::/32")).toBe("2001:db8::/32");
  });
  it("rejects malformed IPv6", () => {
    expect(store.normalizeCidr("2001:db8:::1")).toBeNull();
    expect(store.normalizeCidr("2001:db8::/129")).toBeNull();
  });
});

describe("ipInCidr", () => {
  it("matches inside IPv4 CIDR", () => {
    expect(store.ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(store.ipInCidr("203.0.113.42", "203.0.113.42/32")).toBe(true);
  });
  it("rejects outside IPv4 CIDR", () => {
    expect(store.ipInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
    expect(store.ipInCidr("203.0.113.43", "203.0.113.42/32")).toBe(false);
  });
  it("never matches across families", () => {
    expect(store.ipInCidr("10.0.0.1", "2001:db8::/32")).toBe(false);
    expect(store.ipInCidr("2001:db8::1", "10.0.0.0/8")).toBe(false);
  });
  it("matches inside IPv6 CIDR", () => {
    expect(store.ipInCidr("2001:db8::dead:beef", "2001:db8::/32")).toBe(true);
    expect(store.ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
  });
  it("CIDR /0 matches everything in family", () => {
    expect(store.ipInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
    expect(store.ipInCidr("2001:db8::1", "::/0")).toBe(true);
  });
});

describe("ipAllowedForKey", () => {
  it("returns true when no allowlist set (open by default)", () => {
    expect(store.ipAllowedForKey({ allowed_cidrs: null }, "1.2.3.4")).toBe(true);
    expect(store.ipAllowedForKey({ allowed_cidrs: undefined as unknown as null }, "1.2.3.4")).toBe(true);
    expect(store.ipAllowedForKey({ allowed_cidrs: [] }, "1.2.3.4")).toBe(true);
  });
  it("permits matching IP", () => {
    expect(
      store.ipAllowedForKey({ allowed_cidrs: ["10.0.0.0/8"] }, "10.1.2.3"),
    ).toBe(true);
  });
  it("denies non-matching IP", () => {
    expect(
      store.ipAllowedForKey({ allowed_cidrs: ["10.0.0.0/8"] }, "192.168.1.1"),
    ).toBe(false);
  });
  it("fails closed when client IP is empty and an allowlist exists", () => {
    expect(
      store.ipAllowedForKey({ allowed_cidrs: ["10.0.0.0/8"] }, ""),
    ).toBe(false);
  });
  it("allows when any CIDR in the list matches", () => {
    expect(
      store.ipAllowedForKey(
        { allowed_cidrs: ["10.0.0.0/8", "203.0.113.42/32"] },
        "203.0.113.42",
      ),
    ).toBe(true);
  });
});

describe("normalizeAllowedCidrs", () => {
  it("drops invalid entries and dedupes after normalization", () => {
    const out = store.normalizeAllowedCidrs([
      "10.0.0.0/8",
      "10.0.0.0/8",
      "garbage",
      "203.0.113.7",
    ]);
    expect(out).toEqual(["10.0.0.0/8", "203.0.113.7/32"]);
  });
  it("returns null for null, undefined, empty array, or all-invalid input", () => {
    expect(store.normalizeAllowedCidrs(null)).toBeNull();
    expect(store.normalizeAllowedCidrs(undefined)).toBeNull();
    expect(store.normalizeAllowedCidrs([])).toBeNull();
    expect(store.normalizeAllowedCidrs(["bogus", ""])).toBeNull();
  });
  it("caps oversized lists at MAX_KEY_CIDRS", () => {
    const big = Array.from({ length: store.MAX_KEY_CIDRS + 20 }, (_, i) => `10.${i >> 8}.${i & 0xff}.0/24`);
    const out = store.normalizeAllowedCidrs(big);
    expect(out!.length).toBe(store.MAX_KEY_CIDRS);
  });
});

describe("createKey + updateKey wire CIDRs through end-to-end", () => {
  it("createKey persists allowed_cidrs and verifyKey + ipAllowedForKey together gate /v1", async () => {
    const { record } = await store.createKey(
      "prod-egress",
      ["predict", "read"],
      null,
      ["203.0.113.42/32"],
    );
    expect(record.allowed_cidrs).toEqual(["203.0.113.42/32"]);

    // Simulate what every /v1 route does: verifyKey, then ipAllowedForKey.
    // Same plaintext path: we re-create to get the plaintext back.
    const fresh = await store.createKey(
      "prod-egress-2",
      ["predict", "read"],
      null,
      ["10.0.0.0/8"],
    );
    const verified = await store.verifyKey(fresh.plaintext);
    expect(verified).not.toBeNull();
    expect(store.ipAllowedForKey(verified!, "10.5.6.7")).toBe(true);
    expect(store.ipAllowedForKey(verified!, "8.8.8.8")).toBe(false);
  });

  it("updateKey can pin and unpin a key without revoking it", async () => {
    const { record } = await store.createKey("flex", ["predict"], null, null);
    expect(record.allowed_cidrs).toBeNull();

    const pinned = await store.updateKey(record.id, {
      allowed_cidrs: ["192.0.2.0/24"],
    });
    expect(pinned!.allowed_cidrs).toEqual(["192.0.2.0/24"]);
    expect(store.ipAllowedForKey(pinned!, "192.0.2.99")).toBe(true);
    expect(store.ipAllowedForKey(pinned!, "10.0.0.1")).toBe(false);

    const cleared = await store.updateKey(record.id, { allowed_cidrs: null });
    expect(cleared!.allowed_cidrs).toBeNull();
    expect(store.ipAllowedForKey(cleared!, "10.0.0.1")).toBe(true);
  });

  it("publicView exposes allowed_cidrs as a defensive copy", async () => {
    const { record } = await store.createKey(
      "view",
      ["predict"],
      null,
      ["10.0.0.0/8"],
    );
    const view = store.publicView(record);
    expect(view.allowed_cidrs).toEqual(["10.0.0.0/8"]);
    view.allowed_cidrs!.push("hacked");
    // mutating the view must not change stored state
    const again = store.publicView(record);
    expect(again.allowed_cidrs).toEqual(["10.0.0.0/8"]);
  });
});
