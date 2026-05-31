/**
 * /v1/webhooks — key-authenticated webhook management. Exercises auth, scope
 * gating, create with secret-once semantics, list, delete, and the
 * deliveries read endpoint.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-v1-wh-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const keys = await import("../lib/api-keys-store");
const webhooks = await import("../lib/webhooks-store");
const route = await import("../app/v1/webhooks/route");
const idRoute = await import("../app/v1/webhooks/[id]/route");
const delRoute = await import("../app/v1/webhooks/deliveries/route");

type RouteReq = Parameters<typeof route.GET>[0];

function makeReq(
  url: string,
  init: RequestInit = {},
): RouteReq {
  return new Request(url, init) as unknown as RouteReq;
}

beforeEach(async () => {
  for (const f of ["api-keys.json", "webhooks.json"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("/v1/webhooks", () => {
  it("GET 401 without a key", async () => {
    const res = await route.GET(makeReq("http://test/v1/webhooks"));
    expect(res.status).toBe(401);
  });

  it("GET 401 with unknown key", async () => {
    const res = await route.GET(
      makeReq("http://test/v1/webhooks", {
        headers: { authorization: "Bearer adh_bogus" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("GET 403 when scope is missing (predict only)", async () => {
    const { plaintext } = await keys.createKey("p-only", ["predict"]);
    const res = await route.GET(
      makeReq("http://test/v1/webhooks", {
        headers: { authorization: `Bearer ${plaintext}` },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      required_scope: string;
      key_scopes: string[];
    };
    expect(body.required_scope).toBe("webhooks");
    expect(body.key_scopes).toEqual(["predict"]);
  });

  it("GET 200 with read scope returns endpoints", async () => {
    const { plaintext } = await keys.createKey("r-only", ["read"]);
    await webhooks.createEndpoint({
      name: "first",
      url: "https://example.com/hook",
    });
    const res = await route.GET(
      makeReq("http://test/v1/webhooks", {
        headers: { authorization: `Bearer ${plaintext}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      endpoints: Array<{ name: string; url: string; secret_prefix: string }>;
    };
    expect(body.endpoints).toHaveLength(1);
    expect(body.endpoints[0].name).toBe("first");
    expect(body.endpoints[0]).not.toHaveProperty("secret_hash");
    expect(body.endpoints[0]).not.toHaveProperty("secret");
  });

  it("POST creates an endpoint and returns the secret exactly once", async () => {
    const { plaintext } = await keys.createKey("wh", ["webhooks"]);
    const res = await route.POST(
      makeReq("http://test/v1/webhooks", {
        method: "POST",
        headers: {
          authorization: `Bearer ${plaintext}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "via-api",
          url: "https://example.com/created",
          events: ["run.created"],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      secret: string;
      secret_prefix: string;
    };
    expect(body.secret.startsWith("whsec_")).toBe(true);
    expect(body.secret_prefix).toBe(body.secret.slice(0, 12));

    // listing should not leak the plaintext secret
    const list = await route.GET(
      makeReq("http://test/v1/webhooks", {
        headers: { authorization: `Bearer ${plaintext}` },
      }),
    );
    const listed = (await list.json()) as { endpoints: Array<Record<string, unknown>> };
    expect(listed.endpoints).toHaveLength(1);
    expect(listed.endpoints[0]).not.toHaveProperty("secret");
  });

  it("POST 422 on invalid URL", async () => {
    const { plaintext } = await keys.createKey("wh", ["webhooks"]);
    const res = await route.POST(
      makeReq("http://test/v1/webhooks", {
        method: "POST",
        headers: {
          authorization: `Bearer ${plaintext}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "x", url: "not-a-url" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("DELETE removes an endpoint, then 404 on repeat", async () => {
    const { plaintext } = await keys.createKey("wh", ["webhooks"]);
    const created = await webhooks.createEndpoint({
      name: "doomed",
      url: "https://example.com/d",
    });
    const ctx = { params: Promise.resolve({ id: created.record.id }) };
    const res1 = await idRoute.DELETE(
      makeReq(`http://test/v1/webhooks/${created.record.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      ctx,
    );
    expect(res1.status).toBe(200);
    const res2 = await idRoute.DELETE(
      makeReq(`http://test/v1/webhooks/${created.record.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      { params: Promise.resolve({ id: created.record.id }) },
    );
    expect(res2.status).toBe(404);
  });

  it("DELETE 403 without webhooks scope (read alone is not enough)", async () => {
    const { plaintext } = await keys.createKey("r", ["read"]);
    const created = await webhooks.createEndpoint({
      name: "safe",
      url: "https://example.com/s",
    });
    const res = await idRoute.DELETE(
      makeReq(`http://test/v1/webhooks/${created.record.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      { params: Promise.resolve({ id: created.record.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("GET /v1/webhooks/deliveries returns sanitized rows", async () => {
    const { plaintext } = await keys.createKey("wh", ["webhooks"]);
    const ep = await webhooks.createEndpoint({
      name: "d",
      url: "https://example.com/d",
    });
    await webhooks.recordDelivery({
      id: webhooks.newDeliveryId(),
      endpoint_id: ep.record.id,
      event: "test.ping",
      url: ep.record.url,
      payload: { hello: "world" },
      created_at: Date.now(),
      finished_at: Date.now(),
      delivered: true,
      attempts: [
        { attempt: 1, at: Date.now(), status: 200, ok: true, duration_ms: 12, error: null },
      ],
    });
    const res = await delRoute.GET(
      makeReq("http://test/v1/webhooks/deliveries?limit=10", {
        headers: { authorization: `Bearer ${plaintext}` },
      }) as Parameters<typeof delRoute.GET>[0],
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliveries: Array<{ event: string; status: string; attempts: number }>;
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.deliveries[0].event).toBe("test.ping");
    expect(body.deliveries[0].status).toBe("ok");
    expect(body.deliveries[0].attempts).toBe(1);
  });
});
