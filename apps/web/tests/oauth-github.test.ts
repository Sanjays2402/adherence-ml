import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-oauth-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";
process.env.GITHUB_CLIENT_ID = "test-client-id";
process.env.GITHUB_CLIENT_SECRET = "test-client-secret";

const { NextRequest } = await import("next/server");
const oauth = await import("../lib/oauth-state");
const users = await import("../lib/users-store");
const startRoute = await import("../app/api/auth/github/route");
const cbRoute = await import("../app/api/auth/github/callback/route");

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
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
});

function makeReq(url: string, cookies: Record<string, string> = {}) {
  const headers = new Headers();
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookieHeader) headers.set("cookie", cookieHeader);
  return new NextRequest(url, { method: "GET", headers });
}

describe("oauth-state: sign + verify", () => {
  it("round-trips a state value", () => {
    const s = oauth.buildOAuthState("github", "/dashboard");
    const p = oauth.verifyOAuthState(s, "github");
    expect(p?.nx).toBe("/dashboard");
    expect(p?.p).toBe("github");
  });

  it("rejects a tampered state value", () => {
    const s = oauth.buildOAuthState("github", "/");
    const tampered = s.slice(0, -2) + "AA";
    expect(oauth.verifyOAuthState(tampered, "github")).toBeNull();
  });

  it("rejects a wrong provider", () => {
    const s = oauth.buildOAuthState("github", "/");
    expect(oauth.verifyOAuthState(s, "google")).toBeNull();
  });

  it("isGithubOAuthConfigured reflects env", () => {
    expect(oauth.isGithubOAuthConfigured()).toBe(true);
  });
});

describe("GET /api/auth/github (start)", () => {
  it("redirects to github with a signed state cookie", async () => {
    const res = await startRoute.GET(
      makeReq("http://localhost:3000/api/auth/github?next=/history"),
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("https://github.com/login/oauth/authorize")).toBe(true);
    const u = new URL(loc);
    expect(u.searchParams.get("client_id")).toBe("test-client-id");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/github/callback",
    );
    const state = u.searchParams.get("state");
    expect(state).toBeTruthy();
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("adh_oauth_state=" + state);
    const payload = oauth.verifyOAuthState(state!, "github");
    expect(payload?.nx).toBe("/history");
  });
});

describe("GET /api/auth/github/callback", () => {
  it("rejects state mismatch", async () => {
    const res = await cbRoute.GET(
      makeReq(
        "http://localhost:3000/api/auth/github/callback?code=abc&state=xxx",
        { adh_oauth_state: "yyy" },
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=oauth_state");
  });

  it("exchanges code, fetches email, and sets session cookie", async () => {
    const state = oauth.buildOAuthState("github", "/dashboard");
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      calls.push(url);
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "tok_xyz" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ email: null, login: "octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user/emails") {
        return new Response(
          JSON.stringify([
            { email: "secondary@example.com", primary: false, verified: true },
            { email: "octo@example.com", primary: true, verified: true },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await cbRoute.GET(
      makeReq(
        `http://localhost:3000/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
        { adh_oauth_state: state },
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("adh_session=");
    expect(calls.some((u) => u.startsWith("https://github.com/login/oauth/access_token"))).toBe(true);
    expect(calls.some((u) => u === "https://api.github.com/user/emails")).toBe(true);

    // user actually created
    const found = await users.getOrCreateUserByEmail("octo@example.com");
    expect(found.email).toBe("octo@example.com");
  });

  it("redirects with error when no verified email is returned", async () => {
    const state = oauth.buildOAuthState("github", "/");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const res = await cbRoute.GET(
      makeReq(
        `http://localhost:3000/api/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
        { adh_oauth_state: state },
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=oauth_no_email");
  });
});
