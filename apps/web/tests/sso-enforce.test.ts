import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-sso-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";

const ws = await import("../lib/workspaces-store");
const oidc = await import("../lib/oidc");
const { NextRequest } = await import("next/server");

beforeEach(async () => {
  for (const f of ["workspaces.json", "users.json"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_SESSION_SECRET;
});

describe("workspaces-store: SSO config", () => {
  it("only the owner can set SSO and enforce requires at least one domain", async () => {
    const [a] = await ws.listForUser("u_alice", "alice@acme.com");
    // invite member as editor
    const { token } = await ws.createInvite(a.id, "u_alice", "bob@acme.com", "editor");
    await ws.acceptInvite(token, "u_bob", "bob@acme.com");
    await expect(
      ws.setWorkspaceSso(a.id, "u_bob", {
        provider: "oidc",
        label: "Acme Okta",
        issuer: "https://acme.okta.com",
        client_id: "cid",
        client_secret: "csec",
        allowed_email_domains: ["acme.com"],
        enforce: true,
      }),
    ).rejects.toThrow(/owner/);

    await expect(
      ws.setWorkspaceSso(a.id, "u_alice", {
        provider: "oidc",
        label: "Acme Okta",
        issuer: "https://acme.okta.com",
        client_id: "cid",
        client_secret: "csec",
        allowed_email_domains: [],
        enforce: true,
      }),
    ).rejects.toThrow(/allowed_email_domain/);
  });

  it("findSsoForEmail picks the enforcing workspace and refuses unknown domains", async () => {
    const [a] = await ws.listForUser("u_alice", "alice@acme.com");
    await ws.setWorkspaceSso(a.id, "u_alice", {
      provider: "oidc",
      label: "Acme Okta",
      issuer: "https://acme.okta.com",
      client_id: "cid",
      client_secret: "csec",
      allowed_email_domains: ["acme.com"],
      enforce: true,
    });
    const hit = await ws.findSsoForEmail("user@acme.com");
    expect(hit?.workspace.id).toBe(a.id);
    expect(hit?.sso.enforce).toBe(true);
    expect(await ws.findSsoForEmail("user@other.com")).toBeNull();
  });

  it("publicSso strips the client_secret", async () => {
    const [a] = await ws.listForUser("u_alice", "alice@acme.com");
    const pub = await ws.setWorkspaceSso(a.id, "u_alice", {
      provider: "oidc",
      label: "Acme Okta",
      issuer: "https://acme.okta.com/",
      client_id: "cid",
      client_secret: "super-secret",
      allowed_email_domains: ["acme.com"],
      enforce: false,
    });
    expect(pub).toBeTruthy();
    expect((pub as unknown as Record<string, unknown>).client_secret).toBeUndefined();
    expect(pub!.has_client_secret).toBe(true);
    // trailing slash trimmed
    expect(pub!.issuer).toBe("https://acme.okta.com");
  });

  it("rejects non-https issuer", async () => {
    const [a] = await ws.listForUser("u_alice", "alice@acme.com");
    await expect(
      ws.setWorkspaceSso(a.id, "u_alice", {
        provider: "oidc",
        label: "x",
        issuer: "http://nope.example.com",
        client_id: "cid",
        client_secret: "csec",
        allowed_email_domains: ["acme.com"],
        enforce: false,
      }),
    ).rejects.toThrow(/https/);
  });
});

describe("auth routes: SSO enforcement blocks magic link and GitHub", () => {
  beforeAll(() => {
    process.env.ADHERENCE_PUBLIC_BASE_URL = "http://localhost:3000";
  });

  it("/api/auth/request returns 403 sso_required for enforced domain", async () => {
    const [a] = await ws.listForUser("u_alice", "alice@acme.com");
    await ws.setWorkspaceSso(a.id, "u_alice", {
      provider: "oidc",
      label: "Acme Okta",
      issuer: "https://acme.okta.com",
      client_id: "cid",
      client_secret: "csec",
      allowed_email_domains: ["acme.com"],
      enforce: true,
    });
    const mod = await import("../app/api/auth/request/route");
    const req = new NextRequest("http://localhost:3000/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@acme.com" }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string }; sso: { workspace_id: string; start_url: string } };
    expect(j.error.code).toBe("sso_required");
    expect(j.sso.workspace_id).toBe(a.id);
    expect(j.sso.start_url).toContain("/api/auth/sso/start?workspace=");
  });

  it("/api/auth/request still issues a magic link for non-enforced domain", async () => {
    const [a] = await ws.listForUser("u_alice", "alice@acme.com");
    await ws.setWorkspaceSso(a.id, "u_alice", {
      provider: "oidc",
      label: "Acme",
      issuer: "https://acme.okta.com",
      client_id: "cid",
      client_secret: "csec",
      allowed_email_domains: ["acme.com"],
      enforce: false, // not enforced
    });
    const mod = await import("../app/api/auth/request/route");
    const req = new NextRequest("http://localhost:3000/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@acme.com" }),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });
});

describe("oidc: state and PKCE helpers", () => {
  it("HMAC-signed state round-trips and rejects tampering", () => {
    const { value, payload } = oidc.buildSsoState("ws_x", "/dashboard");
    expect(payload.ws).toBe("ws_x");
    const ok = oidc.verifySsoState(value);
    expect(ok?.ws).toBe("ws_x");
    expect(ok?.nx).toBe("/dashboard");
    // flip a byte in the payload portion
    const dot = value.indexOf(".");
    const tampered = value.slice(0, dot - 1) + (value[dot - 1] === "A" ? "B" : "A") + value.slice(dot);
    expect(oidc.verifySsoState(tampered)).toBeNull();
    expect(oidc.verifySsoState(undefined)).toBeNull();
    expect(oidc.verifySsoState("nope")).toBeNull();
  });

  it("normalizes // and protocol-relative next paths to /", () => {
    const { payload } = oidc.buildSsoState("ws_x", "//evil.example.com");
    expect(payload.nx).toBe("/");
    const { payload: p2 } = oidc.buildSsoState("ws_x", "https://evil.com");
    expect(p2.nx).toBe("/");
  });

  it("PKCE S256 challenge matches RFC 7636 example", () => {
    // From RFC 7636 appendix B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = oidc.pkceChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
