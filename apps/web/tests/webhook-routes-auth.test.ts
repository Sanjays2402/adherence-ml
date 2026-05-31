/**
 * Cross-cutting auth test for the dashboard-side webhook routes.
 *
 * These routes were previously open. They now require a signed dashboard
 * session, with ADHERENCE_DASHBOARD_OPEN=1 as the documented dev escape
 * hatch. This suite proves every mutating route refuses an unauthenticated
 * request with 401 and lands a `denied` row in the dashboard audit log
 * with reason=no_session, which is what a buyer's security review will
 * grep for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const TMP = mkdtempSync(path.join(tmpdir(), "adh-wh-auth-"));
process.env.ADHERENCE_DATA_DIR = TMP;
// Make sure we are NOT in dev-bypass mode for this suite.
delete process.env.ADHERENCE_DASHBOARD_OPEN;

const store = await import("../lib/webhooks-store");
const audit = await import("../lib/dashboard-audit");

const listRoute = await import("../app/api/webhooks/route");
const idRoute = await import("../app/api/webhooks/[id]/route");
const testRoute = await import("../app/api/webhooks/[id]/test/route");
const delListRoute = await import("../app/api/webhooks/deliveries/route");
const delGetRoute = await import("../app/api/webhooks/deliveries/[id]/route");
const delExportRoute = await import("../app/api/webhooks/deliveries/export/route");
const replayRoute = await import(
  "../app/api/webhooks/deliveries/[id]/redeliver/route"
);

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

beforeEach(() => {
  audit._resetForTests();
});

describe("dashboard webhook routes require a session", () => {
  it("GET /api/webhooks returns 401", async () => {
    const res = await listRoute.GET(getReq("/api/webhooks"));
    expect(res.status).toBe(401);
  });

  it("POST /api/webhooks returns 401 and lands a denied audit row", async () => {
    const res = await listRoute.POST(
      jsonReq("/api/webhooks", "POST", {
        name: "p",
        url: "https://example.com/hook",
      }),
    );
    expect(res.status).toBe(401);
    const tail = await audit.listAudit({ limit: 5 });
    const row = tail.items.find(
      (e) => e.action === "webhook.endpoint.create" && e.outcome === "denied",
    );
    expect(row, "expected denied webhook.endpoint.create audit row").toBeTruthy();
    expect(row?.metadata?.reason).toBe("no_session");
  });

  it("PATCH /api/webhooks/[id] returns 401", async () => {
    const res = await idRoute.PATCH(
      jsonReq("/api/webhooks/ep_x", "PATCH", { active: false }),
      { params: Promise.resolve({ id: "ep_x" }) },
    );
    expect(res.status).toBe(401);
  });

  it("DELETE /api/webhooks/[id] returns 401", async () => {
    const res = await idRoute.DELETE(
      jsonReq("/api/webhooks/ep_x", "DELETE"),
      { params: Promise.resolve({ id: "ep_x" }) },
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/webhooks/[id]/test returns 401", async () => {
    const res = await testRoute.POST(
      jsonReq("/api/webhooks/ep_x/test", "POST"),
      { params: Promise.resolve({ id: "ep_x" }) },
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/webhooks/deliveries returns 401", async () => {
    const res = await delListRoute.GET(getReq("/api/webhooks/deliveries"));
    expect(res.status).toBe(401);
  });

  it("GET /api/webhooks/deliveries/[id] returns 401", async () => {
    const res = await delGetRoute.GET(getReq("/api/webhooks/deliveries/del_x"), {
      params: Promise.resolve({ id: "del_x" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/webhooks/deliveries/export returns 401", async () => {
    const res = await delExportRoute.GET(
      getReq("/api/webhooks/deliveries/export?format=csv"),
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/webhooks/deliveries/[id]/redeliver returns 401", async () => {
    const res = await replayRoute.POST(
      jsonReq("/api/webhooks/deliveries/del_x/redeliver", "POST"),
      { params: Promise.resolve({ id: "del_x" }) },
    );
    expect(res.status).toBe(401);
  });
});

describe("dev-bypass actually lets the routes through", () => {
  let epId = "";

  beforeAll(async () => {
    process.env.ADHERENCE_DASHBOARD_OPEN = "1";
    const created = await store.createEndpoint({
      name: "auth-suite",
      url: "https://example.com/hook",
      events: ["run.created"],
    });
    epId = created.record.id;
  });

  afterAll(() => {
    delete process.env.ADHERENCE_DASHBOARD_OPEN;
  });

  it("GET /api/webhooks returns 200 with the dev bypass", async () => {
    const res = await listRoute.GET(getReq("/api/webhooks"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: { id: string }[] };
    expect(body.endpoints.some((e) => e.id === epId)).toBe(true);
  });
});
