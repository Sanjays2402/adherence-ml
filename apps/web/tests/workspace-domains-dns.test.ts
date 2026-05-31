import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  __setTxtResolverForTests,
  expectedTxtValue,
  verificationHost,
  verifyDomainTxt,
} from "../lib/dns-verify";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-domains-dns-"));
  process.env.ADHERENCE_DATA_DIR = dir;
  delete process.env.ADHERENCE_DOMAIN_DNS_ALLOW_BYPASS;
});

afterEach(() => {
  __setTxtResolverForTests(null);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("verifyDomainTxt", () => {
  it("returns ok when the TXT record carries the expected token", async () => {
    __setTxtResolverForTests(async (host) => {
      expect(host).toBe(verificationHost("acme.test"));
      return [["adherence-ml-verify=abc123"]];
    });
    const r = await verifyDomainTxt("acme.test", "abc123");
    expect(r.ok).toBe(true);
  });

  it("reassembles multi-chunk TXT records before comparing", async () => {
    const token = "0123456789".repeat(8);
    const expected = expectedTxtValue(token);
    const half = expected.slice(0, 40);
    const rest = expected.slice(40);
    __setTxtResolverForTests(async () => [[half, rest]]);
    const r = await verifyDomainTxt("acme.test", token);
    expect(r.ok).toBe(true);
  });

  it("returns token_mismatch_dns when TXT exists but the value is wrong", async () => {
    __setTxtResolverForTests(async () => [["adherence-ml-verify=other-token"]]);
    const r = await verifyDomainTxt("acme.test", "abc123");
    expect(r).toEqual({ ok: false, reason: "token_mismatch_dns" });
  });

  it("returns txt_not_found when the resolver throws ENOTFOUND", async () => {
    __setTxtResolverForTests(async () => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    });
    const r = await verifyDomainTxt("acme.test", "abc123");
    expect(r).toEqual({ ok: false, reason: "txt_not_found", detail: "ENOTFOUND" });
  });

  it("returns dns_lookup_failed for other DNS errors", async () => {
    __setTxtResolverForTests(async () => {
      const err = new Error("servfail") as NodeJS.ErrnoException;
      err.code = "ESERVFAIL";
      throw err;
    });
    const r = await verifyDomainTxt("acme.test", "abc123");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("dns_lookup_failed");
      expect(r.detail).toBe("ESERVFAIL");
    }
  });
});

describe("verifyDomain via real DNS path", () => {
  it("rejects when no TXT record is published, accepts only on real DNS match, and refuses cross-tenant collision", async () => {
    const ws = await import("../lib/workspaces-store");

    const [acme] = await ws.listForUser("u_alice", "alice@acme.test");
    const [other] = await ws.listForUser("u_oscar", "oscar@other.test");
    expect(other.id).not.toBe(acme.id);

    const claim = await ws.claimDomain(acme.id, "u_alice", "acme.test");
    if (typeof claim === "string") throw new Error("claim failed: " + claim);

    // 1. No DNS record yet -> txt_not_found.
    __setTxtResolverForTests(async () => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    });
    expect(await ws.verifyDomain(acme.id, "u_alice", "acme.test")).toBe("txt_not_found");

    // 2. Record exists but wrong value -> token_mismatch_dns.
    __setTxtResolverForTests(async () => [["adherence-ml-verify=wrong"]]);
    expect(await ws.verifyDomain(acme.id, "u_alice", "acme.test")).toBe("token_mismatch_dns");

    // 3. Without the bypass env, supplying the right token by hand is NOT
    //    enough; we must see it in DNS. This is the regression that proves
    //    real verification has replaced operator-trust.
    expect(
      await ws.verifyDomain(acme.id, "u_alice", "acme.test", claim.verification_token),
    ).toBe("token_mismatch_dns");

    // 4. Correct DNS value -> verified.
    __setTxtResolverForTests(async () => [[
      `adherence-ml-verify=${claim.verification_token}`,
    ]]);
    const ok = await ws.verifyDomain(acme.id, "u_alice", "acme.test");
    if (typeof ok === "string") throw new Error("verify failed: " + ok);
    expect(ok.status).toBe("verified");

    // 5. Cross-tenant: another workspace can't even claim the domain once
    //    it is verified elsewhere; the collision is enforced at claim time.
    const claimOther = await ws.claimDomain(other.id, "u_oscar", "acme.test");
    expect(claimOther).toBe("already_verified_elsewhere");
  });
});
