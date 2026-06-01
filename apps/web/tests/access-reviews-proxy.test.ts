/**
 * Access reviews proxy: input validation.
 *
 * Proves the create-review POST rejects bodies shorter than the
 * SOC2 minimum reason length without ever calling the upstream API,
 * and that the decide endpoint rejects unknown decisions and a
 * "change" decision missing new_role.
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
const createMod = await import("../app/api/access-reviews/route");
const decideMod = await import(
  "../app/api/access-reviews/[id]/items/[itemId]/decide/route"
);

beforeEach(() => {
  vi.mocked(apiMod.apiFetch).mockClear();
});

function jsonReq(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("access-reviews proxy validation", () => {
  it("rejects too-short reason without calling upstream", async () => {
    const req = jsonReq("http://localhost/api/access-reviews", {
      reason: "too short",
    });
    const res = await createMod.POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/invalid/i);
    expect(vi.mocked(apiMod.apiFetch)).not.toHaveBeenCalled();
  });

  it("rejects unknown decision values", async () => {
    const req = jsonReq(
      "http://localhost/api/access-reviews/1/items/2/decide",
      { decision: "yeet" },
    );
    const res = await decideMod.POST(req, {
      params: Promise.resolve({ id: "1", itemId: "2" }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(apiMod.apiFetch)).not.toHaveBeenCalled();
  });

  it("rejects change decision without new_role", async () => {
    const req = jsonReq(
      "http://localhost/api/access-reviews/1/items/2/decide",
      { decision: "change" },
    );
    const res = await decideMod.POST(req, {
      params: Promise.resolve({ id: "1", itemId: "2" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/new_role/i);
    expect(vi.mocked(apiMod.apiFetch)).not.toHaveBeenCalled();
  });
});
