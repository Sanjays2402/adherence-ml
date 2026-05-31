import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Isolate file-backed stores under a temp data dir before route import.
const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-digest-route-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const route = await import("../app/api/digest/route");
const settings = await import("../lib/settings-store");

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/digest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  for (const f of ["settings.json", "digest-sent.json", "runs.jsonl"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("POST /api/digest unsubscribe handling", () => {
  it("returns 400 when there is no recipient", async () => {
    // Default contact_email is empty in DEFAULT_SETTINGS.
    const res = await route.POST(makeReq({}) as unknown as Parameters<typeof route.POST>[0]);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("no_recipient");
  });

  it("returns 409 digest_unsubscribed when prefs are off", async () => {
    await settings.writeSettings({
      profile: { contact_email: "owner@example.com" },
      notifications: { email_weekly_digest: false },
    });
    const res = await route.POST(makeReq({}) as unknown as Parameters<typeof route.POST>[0]);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("digest_unsubscribed");
  });

  it("force:true overrides the unsubscribe and logs a send", async () => {
    await settings.writeSettings({
      profile: { contact_email: "owner@example.com" },
      notifications: { email_weekly_digest: false },
    });
    const res = await route.POST(
      makeReq({ force: true }) as unknown as Parameters<typeof route.POST>[0],
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; sent: { to: string } };
    expect(json.ok).toBe(true);
    expect(json.sent.to).toBe("owner@example.com");
  });

  it("sends normally when prefs are on", async () => {
    await settings.writeSettings({
      profile: { contact_email: "owner@example.com" },
      notifications: { email_weekly_digest: true },
    });
    const res = await route.POST(makeReq({}) as unknown as Parameters<typeof route.POST>[0]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });
});
