/**
 * Idempotency-Key middleware test.
 *
 * Proves the contract enterprise procurement reviewers care about:
 *   1. A POST without an Idempotency-Key behaves exactly as before.
 *   2. Two POSTs with the same key + same body return identical responses,
 *      and the second carries `Idempotent-Replay: true`.
 *   3. The same key with a DIFFERENT body returns 409 Conflict (a bug
 *      indicator for the client).
 *   4. Tenant isolation: workspace A's cache never satisfies a workspace B
 *      request, even with the same key value.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-idem-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_DASHBOARD_OPEN = "1";
process.env.ADHERENCE_SESSION_SECRET = "test-secret-idempotency";

const idemStore = await import("../lib/idempotency-store");
const idem = await import("../lib/idempotency");

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_DASHBOARD_OPEN;
  delete process.env.ADHERENCE_SESSION_SECRET;
});

beforeEach(async () => {
  await idemStore._resetForTests();
});

function makeReq(body: string, key?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  return new Request("http://x/api/workspaces/ws_a/invites", {
    method: "POST",
    body,
    headers,
  }) as unknown as import("next/server").NextRequest;
}

describe("Idempotency-Key store", () => {
  it("rejects malformed keys", () => {
    expect(idemStore.isValidIdempotencyKey("")).toBe(false);
    expect(idemStore.isValidIdempotencyKey("short")).toBe(false); // too short
    expect(idemStore.isValidIdempotencyKey("a".repeat(201))).toBe(false);
    expect(idemStore.isValidIdempotencyKey("has space here")).toBe(false);
    expect(idemStore.isValidIdempotencyKey("ok-key-2026")).toBe(true);
  });

  it("hashes request content stably", () => {
    const a = idemStore.hashRequest("POST", "/api/x", '{"a":1}');
    const b = idemStore.hashRequest("POST", "/api/x", '{"a":1}');
    const c = idemStore.hashRequest("POST", "/api/x", '{"a":2}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("Idempotency-Key middleware", () => {
  it("no header -> kind=none and request proceeds normally", async () => {
    const out = await idem.beginIdempotency(makeReq('{"x":1}'), "ws_a", '{"x":1}');
    expect(out.kind).toBe("none");
  });

  it("first call returns live, second identical call returns cached replay", async () => {
    const body = '{"email":"a@b.com","role":"viewer"}';
    const first = await idem.beginIdempotency(
      makeReq(body, "retry-key-001"),
      "ws_a",
      body,
    );
    expect(first.kind).toBe("live");
    if (first.kind !== "live") throw new Error("unreachable");

    const { NextResponse } = await import("next/server");
    const handlerResponse = NextResponse.json({ ok: true, invite_id: "inv_1" });
    const finished = await idem.finishIdempotency(first, handlerResponse);
    expect(finished.headers.get("Idempotency-Key")).toBe("retry-key-001");

    const second = await idem.beginIdempotency(
      makeReq(body, "retry-key-001"),
      "ws_a",
      body,
    );
    expect(second.kind).toBe("replay");
    if (second.kind !== "replay") throw new Error("unreachable");
    expect(second.response.status).toBe(200);
    expect(second.response.headers.get("Idempotent-Replay")).toBe("true");
    expect(second.response.headers.get("Idempotency-Key")).toBe("retry-key-001");
    const replayJson = await second.response.json();
    expect(replayJson).toEqual({ ok: true, invite_id: "inv_1" });
  });

  it("same key with different body returns 409 conflict", async () => {
    const bodyA = '{"email":"a@b.com","role":"viewer"}';
    const bodyB = '{"email":"c@d.com","role":"editor"}';
    const live = await idem.beginIdempotency(makeReq(bodyA, "k-conflict"), "ws_a", bodyA);
    expect(live.kind).toBe("live");
    if (live.kind !== "live") throw new Error("unreachable");
    const { NextResponse } = await import("next/server");
    await idem.finishIdempotency(live, NextResponse.json({ ok: true }));

    const dup = await idem.beginIdempotency(makeReq(bodyB, "k-conflict"), "ws_a", bodyB);
    expect(dup.kind).toBe("conflict");
    if (dup.kind !== "conflict") throw new Error("unreachable");
    expect(dup.response.status).toBe(409);
    const j = await dup.response.json();
    expect(j.code).toBe("idempotency_key_conflict");
  });

  it("tenant isolation: same key in workspace B does NOT hit workspace A's cache", async () => {
    const body = '{"email":"a@b.com","role":"viewer"}';
    const first = await idem.beginIdempotency(makeReq(body, "shared-key"), "ws_a", body);
    expect(first.kind).toBe("live");
    if (first.kind !== "live") throw new Error("unreachable");
    const { NextResponse } = await import("next/server");
    await idem.finishIdempotency(first, NextResponse.json({ ok: true, ws: "A" }));

    // Same key, same body, DIFFERENT workspace -> must be a fresh live call.
    const cross = await idem.beginIdempotency(makeReq(body, "shared-key"), "ws_b", body);
    expect(cross.kind).toBe("live");

    // And listing for workspace B must NOT include workspace A's record.
    const listB = await idemStore.listRecords("ws_b");
    expect(listB).toHaveLength(0);
    const listA = await idemStore.listRecords("ws_a");
    expect(listA).toHaveLength(1);
    expect(listA[0].key).toBe("shared-key");
  });

  it("rejects invalid keys with 400", async () => {
    const out = await idem.beginIdempotency(makeReq("{}", "bad key"), "ws_a", "{}");
    expect(out.kind).toBe("invalid");
    if (out.kind !== "invalid") throw new Error("unreachable");
    expect(out.response.status).toBe(400);
  });

  it("does not cache 4xx/5xx responses", async () => {
    const body = '{"bad":true}';
    const live = await idem.beginIdempotency(makeReq(body, "err-key-1"), "ws_a", body);
    expect(live.kind).toBe("live");
    if (live.kind !== "live") throw new Error("unreachable");
    const { NextResponse } = await import("next/server");
    await idem.finishIdempotency(
      live,
      NextResponse.json({ detail: "nope" }, { status: 400 }),
    );
    // Retry should re-execute (kind=live), not replay.
    const retry = await idem.beginIdempotency(makeReq(body, "err-key-1"), "ws_a", body);
    expect(retry.kind).toBe("live");
  });
});
