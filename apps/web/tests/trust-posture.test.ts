/**
 * Trust Center posture route.
 *
 * Procurement uses /trust to verify our live security posture without
 * an account. The route must:
 *   1. respond on a clean GET (no auth, no headers)
 *   2. return the documented JSON shape
 *   3. include the security-headers check, which is deterministic and
 *      proves the dashboard ships with the OWASP baseline CSP
 *   4. degrade gracefully when the upstream API is unreachable
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Default: simulate every upstream probe failing. The route should
  // still return 200 with a fail/unknown badge on the affected checks
  // but a pass on security-headers because that one is local.
  globalThis.fetch = vi.fn(async () => {
    throw new Error("upstream unreachable");
  }) as unknown as typeof fetch;
});

describe("GET /api/trust/posture", () => {
  it("returns the documented shape with deterministic checks when upstream is down", async () => {
    const mod = await import("@/app/api/trust/posture/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overall: string;
      checks: { id: string; status: string; label: string; detail: string }[];
      generated_at: string;
      region: string;
    };

    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBeGreaterThanOrEqual(5);
    const ids = body.checks.map((c) => c.id);
    expect(ids).toContain("liveness");
    expect(ids).toContain("readiness");
    expect(ids).toContain("audit-chain");
    expect(ids).toContain("security-headers");
    expect(ids).toContain("sso");

    const headersCheck = body.checks.find((c) => c.id === "security-headers");
    // Local check must pass even when upstream is unreachable.
    expect(headersCheck?.status).toBe("pass");

    const liveness = body.checks.find((c) => c.id === "liveness");
    expect(liveness?.status).toBe("fail");

    expect(["pass", "warn", "fail", "unknown"]).toContain(body.overall);
    expect(typeof body.generated_at).toBe("string");
    expect(typeof body.region).toBe("string");
  });

  it("flags audit-chain as healthy when upstream answers 401 to an unauthenticated probe", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/readyz")) return new Response("ok", { status: 200 });
      if (url.endsWith("/healthz"))
        return new Response(JSON.stringify({ version: "0.1.0", status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/v1/audit/chain/verify"))
        return new Response("unauthorized", { status: 401 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const mod = await import("@/app/api/trust/posture/route");
    const res = await mod.GET();
    const body = (await res.json()) as { checks: { id: string; status: string }[] };
    const audit = body.checks.find((c) => c.id === "audit-chain");
    expect(audit?.status).toBe("pass");
    const health = body.checks.find((c) => c.id === "health");
    expect(health?.status).toBe("pass");
  });

  it("sets a cache header so the public probe can be safely scraped", async () => {
    const mod = await import("@/app/api/trust/posture/route");
    const res = await mod.GET();
    expect(res.headers.get("cache-control")).toContain("max-age=60");
  });
});
