/**
 * Retention policy proxy: input validation.
 *
 * Proves the PUT and sweep endpoints reject malformed bodies without
 * ever reaching the upstream FastAPI, so a misconfigured admin UI or
 * a hostile caller cannot trigger a sweep with out-of-range TTLs or
 * a non-integer payload.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, msg: string, body?: unknown) {
      super(msg);
      this.status = status;
      this.body = body;
    }
  },
  apiFetch: vi.fn(async () => {
    throw new Error("upstream MUST NOT be called for invalid input");
  }),
}));

const apiMod = await import("../lib/api");
const policyMod = await import("../app/api/retention-policy/route");
const sweepMod = await import("../app/api/retention-policy/sweep/route");

beforeEach(() => {
  vi.mocked(apiMod.apiFetch).mockClear();
});

function putReq(body: unknown, qs = "") {
  return new NextRequest(`http://localhost/api/retention-policy${qs}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sweepReq(body: unknown) {
  return new NextRequest("http://localhost/api/retention-policy/sweep", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("retention-policy proxy validation", () => {
  it("rejects empty ttls_days without calling upstream", async () => {
    const res = await policyMod.PUT(putReq({ ttls_days: {} }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/invalid/i);
    expect(vi.mocked(apiMod.apiFetch)).not.toHaveBeenCalled();
  });

  it("rejects ttl values outside the allowed range", async () => {
    const res = await policyMod.PUT(
      putReq({ ttls_days: { predictions: 99999 } }),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(apiMod.apiFetch)).not.toHaveBeenCalled();
  });

  it("rejects non-integer ttl values", async () => {
    const res = await policyMod.PUT(
      putReq({ ttls_days: { predictions: 30.5 } }),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(apiMod.apiFetch)).not.toHaveBeenCalled();
  });

  it("rejects sweep with non-boolean dry_run", async () => {
    const res = await sweepMod.POST(sweepReq({ dry_run: "yes please" }));
    expect(res.status).toBe(400);
    expect(vi.mocked(apiMod.apiFetch)).not.toHaveBeenCalled();
  });

  it("rejects sweep with ttl out of range", async () => {
    const res = await sweepMod.POST(
      sweepReq({ dry_run: true, ttls_days: { predictions: 0 } }),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(apiMod.apiFetch)).not.toHaveBeenCalled();
  });

  it("accepts a well-formed sweep payload and forwards to upstream", async () => {
    vi.mocked(apiMod.apiFetch).mockResolvedValueOnce({
      tenant_id: "t1",
      dry_run: true,
      results: [],
    });
    const res = await sweepMod.POST(
      sweepReq({ dry_run: true, ttls_days: { predictions: 30 } }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(apiMod.apiFetch)).toHaveBeenCalledTimes(1);
    const [path, init] = vi.mocked(apiMod.apiFetch).mock.calls[0];
    expect(path).toBe("/v1/workspace/retention-policy/sweep");
    expect(init?.method).toBe("POST");
  });
});
