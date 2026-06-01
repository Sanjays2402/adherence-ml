/**
 * /api/webhooks/inbound-config gates on a dashboard session.
 *
 * The inbound posture reveals which partner systems can post outcome
 * events into the model and which IP ranges they may use. Both pieces
 * are SSRF/targeting hints, so the endpoint must refuse an
 * unauthenticated request even though the underlying service-token
 * call to FastAPI would succeed.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const TMP = mkdtempSync(path.join(tmpdir(), "adh-inbound-cfg-"));
process.env.ADHERENCE_DATA_DIR = TMP;
delete process.env.ADHERENCE_DASHBOARD_OPEN;

const audit = await import("../lib/dashboard-audit");

// Stub the upstream call so the test never tries to reach FastAPI.
vi.mock("@/lib/api", async () => {
  return {
    ApiError: class ApiError extends Error {
      status = 500;
      body: unknown = null;
    },
    apiFetch: vi.fn(async () => ({
      require_signed: true,
      max_skew_seconds: 300,
      sources: [
        {
          source: "medtracker",
          signed: true,
          ip_restricted: true,
          allowed_cidrs: ["203.0.113.0/24"],
        },
      ],
    })),
  };
});

const route = await import("../app/api/webhooks/inbound-config/route");

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

describe("/api/webhooks/inbound-config", () => {
  it("returns 401 without a session and lands a denied audit row", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/inbound-config");
    const res = await route.GET(req);
    expect(res.status).toBe(401);
    const tail = await audit.listAudit({ limit: 5 });
    const row = tail.items.find(
      (e) =>
        e.action === "webhooks.inbound.config.read" && e.outcome === "denied",
    );
    expect(row, "expected denied audit row").toBeTruthy();
    expect(row?.metadata?.reason).toBe("no_session");
  });

  it("returns the posture when ADHERENCE_DASHBOARD_OPEN=1", async () => {
    process.env.ADHERENCE_DASHBOARD_OPEN = "1";
    try {
      const req = new NextRequest(
        "http://localhost/api/webhooks/inbound-config",
      );
      const res = await route.GET(req);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        require_signed: boolean;
        sources: Array<{ source: string; signed: boolean }>;
      };
      expect(body.require_signed).toBe(true);
      expect(body.sources[0].source).toBe("medtracker");
      expect(body.sources[0].signed).toBe(true);
    } finally {
      delete process.env.ADHERENCE_DASHBOARD_OPEN;
    }
  });
});
