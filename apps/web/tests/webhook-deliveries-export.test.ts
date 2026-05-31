import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-wh-export-"));
process.env.ADHERENCE_DATA_DIR = tmp;

// Import after env is set so the file-backed store points at the tmp dir.
const store = await import("../lib/webhooks-store");
const route = await import("../app/api/webhooks/deliveries/export/route");

function req(qs: string) {
  return new NextRequest(`http://localhost/api/webhooks/deliveries/export${qs}`);
}

beforeAll(async () => {
  // Two endpoints, three deliveries with mixed status.
  const ep1 = await store.createEndpoint({
    name: "primary",
    url: "https://example.com/hook",
    events: ["run.created"],
  });
  const ep2 = await store.createEndpoint({
    name: "secondary",
    url: "https://other.example.com/hook",
    events: ["run.created"],
  });

  await store.recordDelivery({
    id: store.newDeliveryId(),
    endpoint_id: ep1.record.id,
    event: "run.created",
    url: ep1.record.url,
    payload: { run_id: "r1" },
    created_at: Date.now() - 3000,
    finished_at: Date.now() - 2500,
    delivered: true,
    attempts: [
      { attempt: 1, at: Date.now() - 2500, status: 200, ok: true, duration_ms: 42, error: null },
    ],
  });
  await store.recordDelivery({
    id: store.newDeliveryId(),
    endpoint_id: ep1.record.id,
    event: "run.created",
    url: ep1.record.url,
    payload: { run_id: "r2", note: 'has "quote" and ,comma' },
    created_at: Date.now() - 2000,
    finished_at: Date.now() - 1900,
    delivered: false,
    attempts: [
      { attempt: 1, at: Date.now() - 1900, status: 500, ok: false, duration_ms: 80, error: "boom" },
    ],
  });
  await store.recordDelivery({
    id: store.newDeliveryId(),
    endpoint_id: ep2.record.id,
    event: "run.created",
    url: ep2.record.url,
    payload: { run_id: "r3" },
    created_at: Date.now() - 1000,
    finished_at: null,
    delivered: false,
    attempts: [],
  });
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("/api/webhooks/deliveries/export", () => {
  it("rejects unknown formats with 400", async () => {
    const res = await route.GET(req("?format=xml"));
    expect(res.status).toBe(400);
  });

  it("returns CSV with a header row and one row per delivery", async () => {
    const res = await route.GET(req("?format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/csv");
    expect(res.headers.get("content-disposition") ?? "").toContain("attachment");
    const body = await res.text();
    const lines = body.trim().split("\n");
    expect(lines[0]).toContain("id,created_at_iso");
    expect(lines.length).toBe(1 + 3);
    // CSV-escaped quote/comma payload roundtrip not in headers, but ensure no parse explosion:
    expect(body).toMatch(/run\.created/);
  });

  it("filters by status=failed", async () => {
    const res = await route.GET(req("?format=csv&status=failed"));
    const body = await res.text();
    const lines = body.trim().split("\n").slice(1);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(",failed,");
  });

  it("returns ndjson with one JSON object per line", async () => {
    const res = await route.GET(req("?format=ndjson"));
    expect(res.headers.get("content-type") ?? "").toContain("ndjson");
    const body = await res.text();
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(3);
    for (const l of lines) {
      const parsed = JSON.parse(l);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("event", "run.created");
    }
  });
});
