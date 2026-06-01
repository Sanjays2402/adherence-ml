import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "whcat-"));
process.env.ADHERENCE_DATA_DIR = tmp;

import type { WebhookEvent } from "../lib/webhooks-store";

const { CATALOG_EVENTS, STABLE_EVENT_TYPES, isSubscribableEvent } = await import(
  "../lib/webhook-catalog"
);
const wstore = await import("../lib/webhooks-store");

beforeEach(async () => {
  const f = path.join(tmp, "webhooks.json");
  if (existsSync(f)) await fs.rm(f);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("webhook event catalog subscribability", () => {
  it("exposes every stable catalog event as subscribable", () => {
    const stableFromCatalog = CATALOG_EVENTS.filter(
      (e: { stability: string }) => e.stability === "stable",
    ).map((e: { event_type: string }) => e.event_type);
    expect(STABLE_EVENT_TYPES.slice().sort()).toEqual(
      stableFromCatalog.slice().sort(),
    );
    // Procurement reviewers care that the surface is non-trivial.
    expect(STABLE_EVENT_TYPES.length).toBeGreaterThanOrEqual(5);
    for (const ev of [
      "run.created",
      "test.ping",
      "intervention.recommended",
      "intervention.high_risk",
      "api_key.rotated",
      "member.invited",
    ]) {
      expect(isSubscribableEvent(ev)).toBe(true);
    }
  });

  it("drops unknown events when creating an endpoint", async () => {
    const created = await wstore.createEndpoint({
      name: "bad",
      url: "https://example.com/hook",
      // intentionally bogus event name; must be silently dropped
      // instead of persisted, so receivers never see a phantom event
      // type they cannot decode.
      events: ["totally.not.real" as unknown as WebhookEvent],
    });
    expect(created.record.events).toEqual([]);
    expect(created.record.events).not.toContain("totally.not.real");
  });

  it("rejects beta catalog events from the subscribable surface", () => {
    // drift.detected is currently in the catalog as beta; it must not
    // be subscribable until promoted to stable.
    const drift = CATALOG_EVENTS.find(
      (e: { event_type: string }) => e.event_type === "drift.detected",
    );
    expect(drift?.stability).toBe("beta");
    expect(isSubscribableEvent("drift.detected")).toBe(false);
  });

  it("accepts subscribing to a freshly-promoted catalog event", async () => {
    const created = await wstore.createEndpoint({
      name: "intervention sink",
      url: "https://example.com/intv",
      events: ["intervention.high_risk", "api_key.rotated"],
    });
    expect(created.record.events).toEqual(
      expect.arrayContaining(["intervention.high_risk", "api_key.rotated"]),
    );
    expect(created.record.events).not.toContain("totally.not.real");
  });
});
