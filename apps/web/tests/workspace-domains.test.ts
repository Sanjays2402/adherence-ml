import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-domains-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("workspaces-store: verified domains + auto-join", () => {
  it("owner can claim, verify, and enable auto-join; non-owner is rejected", async () => {
    const store = await import("../lib/workspaces-store");
    const [ws] = await store.listForUser("u_alice", "alice@acme.com");

    // non-owner cannot claim
    const denied = await store.claimDomain(ws.id, "u_mallory", "acme.com");
    expect(denied).toBe("forbidden");

    // public providers are blocked
    const blocked = await store.claimDomain(ws.id, "u_alice", "gmail.com");
    expect(blocked).toBe("public_provider");

    // malformed domains are blocked
    const bad = await store.claimDomain(ws.id, "u_alice", "not a domain");
    expect(bad).toBe("invalid_domain");

    const v = await store.claimDomain(ws.id, "u_alice", "ACME.com", "editor");
    expect(typeof v).not.toBe("string");
    if (typeof v === "string") throw new Error("claim failed");
    expect(v.domain).toBe("acme.com");
    expect(v.status).toBe("pending");
    expect(v.auto_join).toBe(false);

    // cannot enable auto-join while pending
    const tooEarly = await store.setDomainAutoJoin(ws.id, "u_alice", "acme.com", { auto_join: true });
    expect(tooEarly).toBe("not_verified_yet");

    // wrong token rejected
    const wrong = await store.verifyDomain(ws.id, "u_alice", "acme.com", "deadbeef");
    expect(wrong).toBe("not_verified_yet");

    // correct token verifies
    const ok = await store.verifyDomain(ws.id, "u_alice", "acme.com", v.verification_token);
    if (typeof ok === "string") throw new Error("verify failed: " + ok);
    expect(ok.status).toBe("verified");

    const enabled = await store.setDomainAutoJoin(ws.id, "u_alice", "acme.com", {
      auto_join: true,
      default_role: "editor",
    });
    if (typeof enabled === "string") throw new Error("enable failed");
    expect(enabled.auto_join).toBe(true);
    expect(enabled.default_role).toBe("editor");
  });

  it("auto-joins new sign-ins from a verified domain, scoped to that workspace only", async () => {
    const store = await import("../lib/workspaces-store");
    const [acme] = await store.listForUser("u_alice", "alice@acme.com");
    const [other] = await store.listForUser("u_other", "owner@other.io");
    expect(other.id).not.toBe(acme.id);

    const v = await store.claimDomain(acme.id, "u_alice", "acme.com");
    if (typeof v === "string") throw new Error("claim failed");
    await store.verifyDomain(acme.id, "u_alice", "acme.com", v.verification_token);
    await store.setDomainAutoJoin(acme.id, "u_alice", "acme.com", {
      auto_join: true,
      default_role: "editor",
    });

    // bob signs in with an acme.com address: should land in acme as editor,
    // and MUST NOT see the other workspace.
    const bobList = await store.listForUser("u_bob", "bob@acme.com");
    const bobAcme = bobList.find((w) => w.id === acme.id);
    expect(bobAcme).toBeDefined();
    expect(bobAcme?.role).toBe("editor");
    expect(bobList.find((w) => w.id === other.id)).toBeUndefined();

    // carol signs in with a different domain: must NOT be auto-joined to acme
    const carolList = await store.listForUser("u_carol", "carol@elsewhere.com");
    expect(carolList.find((w) => w.id === acme.id)).toBeUndefined();
  });

  it("blocks cross-tenant verified-domain collision", async () => {
    const store = await import("../lib/workspaces-store");
    const [a] = await store.listForUser("u_a", "owner@a.test");
    const [b] = await store.listForUser("u_b", "owner@b.test");

    const v = await store.claimDomain(a.id, "u_a", "shared.com");
    if (typeof v === "string") throw new Error("claim a failed");
    await store.verifyDomain(a.id, "u_a", "shared.com", v.verification_token);

    // workspace B cannot even claim the domain once it is verified elsewhere
    const v2 = await store.claimDomain(b.id, "u_b", "shared.com");
    expect(v2).toBe("already_verified_elsewhere");
  });

  it("unclaim removes the domain and disables future auto-joins", async () => {
    const store = await import("../lib/workspaces-store");
    const [ws] = await store.listForUser("u_alice", "alice@acme.com");
    const v = await store.claimDomain(ws.id, "u_alice", "acme.com");
    if (typeof v === "string") throw new Error("claim failed");
    await store.verifyDomain(ws.id, "u_alice", "acme.com", v.verification_token);
    await store.setDomainAutoJoin(ws.id, "u_alice", "acme.com", { auto_join: true });

    const r = await store.unclaimDomain(ws.id, "u_alice", "acme.com");
    expect(r).toBe(true);

    const after = await store.listVerifiedDomains(ws.id);
    expect(after).toHaveLength(0);

    // new sign-in must NOT be auto-joined now
    const dave = await store.listForUser("u_dave", "dave@acme.com");
    expect(dave.find((w) => w.id === ws.id)).toBeUndefined();
  });
});
