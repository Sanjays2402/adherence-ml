/**
 * /api/workspace/session-policy proxy route.
 *
 * Pure-validation paths only (do not call upstream):
 *   - PUT rejects invalid JSON with 400
 *   - PUT rejects an out-of-range max_age_seconds with 400 and zod issues
 *   - PUT accepts a valid value, then attempts upstream (mocked to throw)
 *     and bubbles a 502 with structured detail.
 *   - GET forwards a dry_run query string when present (verified via fetch mock).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force apiFetch to hit a controllable global fetch.
process.env.ADHERENCE_API_BASE = "http://upstream.test";
process.env.ADHERENCE_API_KEY = "test-key";

const route = await import("../app/api/workspace/session-policy/route");
const { NextRequest } = await import("next/server");

function put(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://test/api/workspace/session-policy", {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  // default: explode so any unexpected upstream call is loud
  globalThis.fetch = vi.fn(async () => {
    throw new Error("unexpected upstream call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("/api/workspace/session-policy proxy", () => {
  it("PUT rejects invalid JSON with 400 before touching upstream", async () => {
    const res = await route.PUT(put("not-json{"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/invalid json/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("PUT rejects out-of-range max_age_seconds with 400 and structured issues", async () => {
    const res = await route.PUT(put({ max_age_seconds: 5 })); // below 5min floor
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      detail: string;
      issues: Array<{ path: (string | number)[] }>;
    };
    expect(body.detail).toMatch(/invalid request/i);
    expect(body.issues.some((i) => i.path[0] === "max_age_seconds")).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("PUT also rejects above-ceiling max_age_seconds (31 days)", async () => {
    const res = await route.PUT(put({ max_age_seconds: 31 * 24 * 3600 }));
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("PUT forwards X-MFA-Code header and dry_run query to upstream", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          tenant_id: "t1",
          max_age_seconds: 3600,
          min_allowed_seconds: 300,
          max_allowed_seconds: 2592000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as Response;
    }) as unknown as typeof fetch;

    const req = new NextRequest(
      "http://test/api/workspace/session-policy?dry_run=true",
      {
        method: "PUT",
        body: JSON.stringify({ max_age_seconds: 3600 }),
        headers: {
          "content-type": "application/json",
          "x-mfa-code": "123456",
          "x-request-id": "rid-abc",
        },
      },
    );

    const res = await route.PUT(req);
    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      "http://upstream.test/v1/workspace/session-policy?dry_run=true",
    );
    expect(capturedHeaders!.get("X-MFA-Code")).toBe("123456");
    expect(capturedHeaders!.get("x-api-key")).toBe("test-key");
    expect(capturedHeaders!.get("x-request-id")).toBe("rid-abc");
  });

  it("bubbles upstream ApiError status and body verbatim", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ detail: "admin MFA required" }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "X-MFA-Required": "totp",
          },
        },
      ) as Response;
    }) as unknown as typeof fetch;

    const res = await route.PUT(put({ max_age_seconds: 3600 }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toBe("admin MFA required");
  });

  it("GET passes through with no body and forwards dry_run", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          tenant_id: "t1",
          max_age_seconds: null,
          min_allowed_seconds: 300,
          max_allowed_seconds: 2592000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as Response;
    }) as unknown as typeof fetch;

    const req = new NextRequest(
      "http://test/api/workspace/session-policy?dry_run=true",
    );
    const res = await route.GET(req);
    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      "http://upstream.test/v1/workspace/session-policy?dry_run=true",
    );
  });
});
