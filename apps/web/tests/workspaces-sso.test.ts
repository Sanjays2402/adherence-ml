import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Verifies the per-workspace SSO config + cross-tenant isolation:
 *
 *   1. Owner can set SSO and read it back without the secret.
 *   2. A non-owner of the workspace cannot mutate SSO.
 *   3. findSsoForEmail routes only emails in allowed_email_domains to the
 *      configuring workspace -- another workspace's user with a different
 *      domain never resolves to that SSO.
 *   4. Enforce mode is honored: the magic-link request route refuses to
 *      mint a token for a domain that requires SSO.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ws-sso-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

async function freshStore() {
  // workspaces-store re-reads the data dir from process.env on every call,
  // and _resetForTests clears any rows persisted by an earlier test.
  const mod = await import("../lib/workspaces-store");
  await mod._resetForTests();
  return mod;
}

describe("workspaces sso enforcement", () => {
  it("owner can set and read SSO; secret never leaks back", async () => {
    const store = await freshStore();
    const [ws] = await store.listForUser("u_owner", "owner@acme.com");
    const pub = await store.setWorkspaceSso(ws.id, "u_owner", {
      provider: "oidc",
      label: "Acme Okta",
      issuer: "https://acme.okta.com/oauth2/default",
      client_id: "abc123",
      client_secret: "super-secret",
      allowed_email_domains: ["acme.com"],
      enforce: true,
    });
    expect(pub).not.toBeNull();
    expect(pub!.has_client_secret).toBe(true);
    expect((pub as unknown as { client_secret?: string }).client_secret).toBeUndefined();
    expect(pub!.enforce).toBe(true);

    const got = await store.getWorkspaceSso(ws.id);
    expect(got?.client_secret).toBe("super-secret");
  });

  it("non-owner cannot mutate SSO", async () => {
    const store = await freshStore();
    const [ws] = await store.listForUser("u_owner", "owner@acme.com");
    // Add a viewer member by accepting an invite.
    const { token } = await store.createInvite(ws.id, "u_owner", "viewer@acme.com", "viewer");
    await store.acceptInvite(token, "u_viewer", "viewer@acme.com");

    await expect(
      store.setWorkspaceSso(ws.id, "u_viewer", {
        provider: "oidc",
        label: "evil",
        issuer: "https://evil.example.com",
        client_id: "x",
        client_secret: "y",
        allowed_email_domains: ["acme.com"],
        enforce: false,
      }),
    ).rejects.toThrow(/owner only/);
  });

  it("findSsoForEmail isolates tenants by domain", async () => {
    const store = await freshStore();
    const [acme] = await store.listForUser("u_acme", "owner@acme.com");
    const [globex] = await store.listForUser("u_globex", "owner@globex.io");
    await store.setWorkspaceSso(acme.id, "u_acme", {
      provider: "oidc",
      label: "Acme Okta",
      issuer: "https://acme.okta.com/oauth2/default",
      client_id: "acme",
      client_secret: "s1",
      allowed_email_domains: ["acme.com"],
      enforce: true,
    });
    await store.setWorkspaceSso(globex.id, "u_globex", {
      provider: "oidc",
      label: "Globex Azure",
      issuer: "https://login.microsoftonline.com/globex/v2.0",
      client_id: "globex",
      client_secret: "s2",
      allowed_email_domains: ["globex.io"],
      enforce: false,
    });

    const acmeMatch = await store.findSsoForEmail("alice@acme.com");
    expect(acmeMatch?.workspace.id).toBe(acme.id);
    expect(acmeMatch?.sso.enforce).toBe(true);

    const globexMatch = await store.findSsoForEmail("bob@globex.io");
    expect(globexMatch?.workspace.id).toBe(globex.id);

    // Cross-tenant email never resolves to either workspace's SSO.
    const outsider = await store.findSsoForEmail("eve@personal.example");
    expect(outsider).toBeNull();
  });

  it("issuer must be https and enforce requires at least one domain", async () => {
    const store = await freshStore();
    const [ws] = await store.listForUser("u_owner", "owner@acme.com");
    await expect(
      store.setWorkspaceSso(ws.id, "u_owner", {
        provider: "oidc",
        label: "Bad",
        issuer: "http://insecure.example.com",
        client_id: "x",
        client_secret: "y",
        allowed_email_domains: ["acme.com"],
        enforce: false,
      }),
    ).rejects.toThrow(/https/);

    await expect(
      store.setWorkspaceSso(ws.id, "u_owner", {
        provider: "oidc",
        label: "Bad",
        issuer: "https://acme.okta.com/oauth2/default",
        client_id: "x",
        client_secret: "y",
        allowed_email_domains: [],
        enforce: true,
      }),
    ).rejects.toThrow(/allowed_email_domain/);
  });

  it("magic-link request route refuses an enforced SSO domain", async () => {
    const store = await freshStore();
    const [ws] = await store.listForUser("u_owner", "owner@acme.com");
    await store.setWorkspaceSso(ws.id, "u_owner", {
      provider: "oidc",
      label: "Acme Okta",
      issuer: "https://acme.okta.com/oauth2/default",
      client_id: "abc",
      client_secret: "shh",
      allowed_email_domains: ["acme.com"],
      enforce: true,
    });

    const { POST } = await import("../app/api/auth/request/route");
    const req = new NextRequest("http://localhost/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@acme.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code: string }; sso?: { workspace_id: string } };
    expect(body.error?.code).toBe("sso_required");
    expect(body.sso?.workspace_id).toBe(ws.id);

    // A different domain still gets a normal magic link response.
    const req2 = new NextRequest("http://localhost/api/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "outsider@personal.example" }),
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(200);
  });
});
