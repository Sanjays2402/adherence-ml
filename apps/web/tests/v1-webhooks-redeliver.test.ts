/**
 * /v1/webhooks/deliveries/[id]/redeliver — programmatic replay of a recorded
 * delivery. Covers auth, scope gating, dry-run preview, missing/inactive
 * endpoint handling, and the happy path against a local HTTP target.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-wh-redeliver-"));
process.env.ADHERENCE_DATA_DIR = tmp;
// This test creates endpoints pointed at a local 127.0.0.1 HTTP server to
// observe real delivery. Opt in to private targets for the harness; the
// metadata-IP block in webhook-ssrf is still enforced.
process.env.ADHERENCE_WEBHOOK_ALLOW_PRIVATE = "1";

const keys = await import("../lib/api-keys-store");
const webhooks = await import("../lib/webhooks-store");
const dispatch = await import("../lib/webhook-dispatch");
const route = await import(
  "../app/v1/webhooks/deliveries/[id]/redeliver/route"
);

type RouteReq = Parameters<typeof route.POST>[0];

function makeReq(url: string, init: RequestInit = {}): RouteReq {
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

function paramsOf(id: string): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

describe("POST /v1/webhooks/deliveries/[id]/redeliver", () => {
  it("401 without an api key", async () => {
    const res = await route.POST(
      makeReq("http://test/v1/webhooks/deliveries/x/redeliver", {
        method: "POST",
      }),
      { params: paramsOf("x") },
    );
    expect(res.status).toBe(401);
  });

  it("403 when key lacks the webhooks scope", async () => {
    const { plaintext } = await keys.createKey("read-only", ["read"]);
    const res = await route.POST(
      makeReq("http://test/v1/webhooks/deliveries/x/redeliver", {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      { params: paramsOf("x") },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required_scope: string };
    expect(body.required_scope).toBe("webhooks");
  });

  it("404 when the delivery id is unknown", async () => {
    const { plaintext } = await keys.createKey("k", ["webhooks"]);
    const res = await route.POST(
      makeReq("http://test/v1/webhooks/deliveries/missing/redeliver", {
        method: "POST",
        headers: { authorization: `Bearer ${plaintext}` },
      }),
      { params: paramsOf("missing") },
    );
    expect(res.status).toBe(404);
    // standard rate-limit headers must be present even on errors
    expect(res.headers.get("x-ratelimit-limit")).toBeTruthy();
  });

  it("409 when the endpoint is inactive", async () => {
    const { plaintext } = await keys.createKey("k", ["webhooks"]);
    const { record: ep } = await webhooks.createEndpoint({
      name: "e",
      url: "https://example.com/h",
    });
    await webhooks.setEndpointActive(ep.id, false);
    const delivery = {
      id: webhooks.newDeliveryId(),
      endpoint_id: ep.id,
      event: "test.ping" as const,
      url: ep.url,
      payload: { hello: "world" },
      created_at: Date.now(),
      finished_at: Date.now(),
      delivered: false,
      attempts: [],
    };
    await webhooks.recordDelivery(delivery);
    const res = await route.POST(
      makeReq(
        `http://test/v1/webhooks/deliveries/${delivery.id}/redeliver`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${plaintext}` },
        },
      ),
      { params: paramsOf(delivery.id) },
    );
    expect(res.status).toBe(409);
  });

  it("dry_run returns a preview without dispatching", async () => {
    const { plaintext } = await keys.createKey("k", ["webhooks"]);
    const { record: ep } = await webhooks.createEndpoint({
      name: "e",
      url: "https://example.com/h",
    });
    const delivery = {
      id: webhooks.newDeliveryId(),
      endpoint_id: ep.id,
      event: "test.ping" as const,
      url: ep.url,
      payload: { hello: "world" },
      created_at: Date.now(),
      finished_at: Date.now(),
      delivered: true,
      attempts: [],
    };
    await webhooks.recordDelivery(delivery);
    const before = await webhooks.listDeliveries({ limit: 100 });
    const res = await route.POST(
      makeReq(
        `http://test/v1/webhooks/deliveries/${delivery.id}/redeliver?dry_run=true`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${plaintext}` },
        },
      ),
      { params: paramsOf(delivery.id) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-dry-run")).toBe("true");
    const body = (await res.json()) as {
      dry_run: boolean;
      would: string;
      preview: { resource: string; id: string };
    };
    expect(body.dry_run).toBe(true);
    expect(body.would).toBe("redeliver");
    expect(body.preview.id).toBe(delivery.id);
    const after = await webhooks.listDeliveries({ limit: 100 });
    expect(after.length).toBe(before.length);
  });

  it("happy path actually redelivers and writes a new delivery row", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const { plaintext } = await keys.createKey("k", ["webhooks"]);
      const { record: ep } = await webhooks.createEndpoint({
        name: "e",
        url: `http://127.0.0.1:${port}/hook`,
      });
      const source = await dispatch.dispatchTest(ep);
      expect(source).not.toBeNull();
      expect(hits).toBeGreaterThanOrEqual(1);
      const baselineHits = hits;

      const res = await route.POST(
        makeReq(
          `http://test/v1/webhooks/deliveries/${source!.id}/redeliver`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${plaintext}` },
          },
        ),
        { params: paramsOf(source!.id) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        delivery_id: string;
        source_id: string;
        delivered: boolean;
      };
      expect(body.source_id).toBe(source!.id);
      expect(body.delivery_id).not.toBe(source!.id);
      expect(body.delivered).toBe(true);
      expect(hits).toBeGreaterThan(baselineHits);
      expect(res.headers.get("x-ratelimit-limit")).toBeTruthy();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
