/**
 * Smoke test for webhook signing + store. Uses an isolated ADHERENCE_DATA_DIR.
 * Run with: pnpm vitest run lib/__tests__/webhooks.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "adh-wh-"));
process.env.ADHERENCE_DATA_DIR = TMP;

// Import AFTER env var so the stores resolve to the temp dir.
import {
  createEndpoint,
  listEndpoints,
  setEndpointActive,
  deleteEndpoint,
  isValidUrl,
  recordDelivery,
  listDeliveries,
  newDeliveryId,
  endpointSecretHash,
} from "../lib/webhooks-store";
import { verifySignature } from "../lib/webhook-dispatch";
import { createHmac } from "node:crypto";

afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe("webhooks-store", () => {
  it("rejects non-http URLs", () => {
    expect(isValidUrl("https://example.com")).toBe(true);
    expect(isValidUrl("http://localhost:9000/hook")).toBe(true);
    expect(isValidUrl("ftp://example.com")).toBe(false);
    expect(isValidUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUrl("not a url")).toBe(false);
  });

  it("creates, toggles, deletes endpoints and never returns the secret twice", async () => {
    const { record, secret } = await createEndpoint({
      name: "primary",
      url: "https://example.com/hook",
    });
    expect(secret).toMatch(/^whsec_/);
    expect(record.id).toMatch(/^ep_/);
    expect(record.active).toBe(true);
    expect(record.events).toContain("run.created");

    const list = await listEndpoints();
    expect(list.find((e) => e.id === record.id)).toBeTruthy();
    // store omits plaintext entirely
    const stored = list.find((e) => e.id === record.id)!;
    expect((stored as unknown as Record<string, unknown>).secret).toBeUndefined();
    expect(stored.secret_prefix.length).toBeGreaterThan(0);

    const toggled = await setEndpointActive(record.id, false);
    expect(toggled?.active).toBe(false);

    const ok = await deleteEndpoint(record.id);
    expect(ok).toBe(true);
    const afterDel = await listEndpoints();
    expect(afterDel.find((e) => e.id === record.id)).toBeUndefined();
  });

  it("appends delivery records and updates counters", async () => {
    const { record } = await createEndpoint({
      name: "counters",
      url: "https://example.com/c",
    });
    const did = newDeliveryId();
    await recordDelivery({
      id: did,
      endpoint_id: record.id,
      event: "run.created",
      url: record.url,
      payload: { hello: "world" },
      created_at: Date.now(),
      finished_at: Date.now(),
      delivered: true,
      attempts: [
        {
          attempt: 1,
          at: Date.now(),
          status: 200,
          ok: true,
          duration_ms: 12,
          error: null,
        },
      ],
    });
    const ds = await listDeliveries({ endpoint_id: record.id });
    expect(ds.length).toBe(1);
    expect(ds[0].delivered).toBe(true);
    const fresh = (await listEndpoints()).find((e) => e.id === record.id)!;
    expect(fresh.success_count).toBe(1);
    expect(fresh.last_delivery_at).not.toBeNull();
  });
});

describe("verifySignature", () => {
  it("accepts a freshly signed body and rejects tampering", async () => {
    const { record } = await createEndpoint({
      name: "sign",
      url: "https://example.com/s",
    });
    const key = (await endpointSecretHash(record.id))!;
    const body = JSON.stringify({ event: "test.ping", n: 1 });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", key).update(`${t}.${body}`).digest("hex");
    const header = `t=${t},v1=${v1}`;
    expect(verifySignature(key, header, body)).toBe(true);
    expect(verifySignature(key, header, body + "x")).toBe(false);
    expect(verifySignature(key, `t=${t},v1=${"a".repeat(64)}`, body)).toBe(false);
  });

  it("rejects stale timestamps", async () => {
    const { record } = await createEndpoint({
      name: "stale",
      url: "https://example.com/x",
    });
    const key = (await endpointSecretHash(record.id))!;
    const body = "{}";
    const t = Math.floor(Date.now() / 1000) - 3600;
    const v1 = createHmac("sha256", key).update(`${t}.${body}`).digest("hex");
    expect(verifySignature(key, `t=${t},v1=${v1}`, body)).toBe(false);
  });
});
