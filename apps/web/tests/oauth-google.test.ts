import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-oauth-google-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.GOOGLE_CLIENT_ID = "google-test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "google-test-client-secret";

const { NextRequest } = await import("next/server");
const oauth = await import("../lib/oauth-state");
const users = await import("../lib/users-store");
const startRoute = await import("../app/api/auth/google/route");
const cbRoute = await import("../app/api/auth/google/callback/route");

beforeAll(async () => {
  await users._resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_SESSION_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

function makeReq(url: string, cookies: Record<string, string> = {}) {
  const headers = new Headers();
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookieHeader) headers.set("cookie", cookieHeader);
  return new NextRequest(url, { method: "GET", headers });
}

describe("oauth-state: google provider", () => {
  it("round-trips a google state value", () => {
    const s = oauth.buildOAuthState("google", "/history");
    const p = oauth.verifyOAuthState(s, "google");
    expect(p?.nx).toBe("/history");
    expect(p?.p).toBe("google");
  });

  it("rejects a github state when verifying google", () => {
    const s = oauth.buildOAuthState("github", "/");
    expect(oauth.verifyOAuthState(s, "google")).toBeNull();
  });

  it("isGoogleOAuthConfigured reflects env", () => {
    expect(oauth.isGoogleOAuthConfigured()).toBe(true);
  });
});

describe("GET /api/auth/google (start)", () => {
  it("redirects to google with a signed state cookie", async () => {
    const res = await startRoute.GET(
      makeReq("http://localhost:3000/api/auth/google?next=/dashboard"),
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth")).toBe(true);
    const u = new URL(loc);
    expect(u.searchParams.get("client_id")).toBe("google-test-client-id");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/google/callback",
    );
    const state = u.searchParams.get("state");
    expect(state).toBeTruthy();
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("adh_oauth_state=" + state);
    const payload = oauth.verifyOAuthState(state!, "google");
    expect(payload?.nx).toBe("/dashboard");
  });

  it("redirects to /login when not configured", async () => {
    const id = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await startRoute.GET(makeReq("http://localhost:3000/api/auth/google"));
    expect(res.headers.get("location")).toContain("/login?error=oauth_unconfigured");
    process.env.GOOGLE_CLIENT_ID = id;
  });
});

describe("GET /api/auth/google/callback", () => {
  it("rejects state mismatch", async () => {
    const res = await cbRoute.GET(
      makeReq(
        "http://localhost:3000/api/auth/google/callback?code=abc&state=xxx",
        { adh_oauth_state: "yyy" },
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=oauth_state");
  });

  it("exchanges code, fetches verified email, and sets session cookie", async () => {
    const state = oauth.buildOAuthState("google", "/dashboard");
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token") {
        // verify exchange details
        const body = String((init as RequestInit | undefined)?.body ?? "");
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=abc");
        return new Response(
          JSON.stringify({ access_token: "g_tok_xyz", id_token: "id" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({
            sub: "1234",
            email: "alice@example.com",
            email_verified: true,
            name: "Alice",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await cbRoute.GET(
      makeReq(
        `http://localhost:3000/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
        { adh_oauth_state: state },
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("adh_session=");
    expect(calls).toContain("https://oauth2.googleapis.com/token");
    expect(calls).toContain("https://openidconnect.googleapis.com/v1/userinfo");

    const found = await users.getOrCreateUserByEmail("alice@example.com");
    expect(found.email).toBe("alice@example.com");
  });

  it("redirects with error when email is unverified", async () => {
    const state = oauth.buildOAuthState("google", "/");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({ email: "bob@example.com", email_verified: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const res = await cbRoute.GET(
      makeReq(
        `http://localhost:3000/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
        { adh_oauth_state: state },
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=oauth_no_email");
  });

  it("redirects to /verify-2fa when the user has TOTP enabled", async () => {
    // Provision a user and enable 2FA on them.
    const u = await users.getOrCreateUserByEmail("twofa@example.com");
    await users.setPendingTotpSecret(u.id, "JBSWY3DPEHPK3PXP");
    await users.enableTotp(u.id, ["recovery-1", "recovery-2"]);

    const state = oauth.buildOAuthState("google", "/dashboard");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({ email: "twofa@example.com", email_verified: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await cbRoute.GET(
      makeReq(
        `http://localhost:3000/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
        { adh_oauth_state: state },
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/verify-2fa");
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("adh_mfa_pending=");
    expect(setCookie).not.toContain("adh_session=");
  });
});
