import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-settings-"));
process.env.ADHERENCE_DATA_DIR = tmp;

// import AFTER env is set so module-level DATA_DIR resolves to tmp
const store = await import("../lib/settings-store");

beforeEach(async () => {
  for (const f of [
    "settings.json",
    "runs.jsonl",
    "api-keys.json",
    "usage.json",
  ]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("settings-store", () => {
  it("returns defaults when no file exists", async () => {
    const s = await store.readSettings();
    expect(s.version).toBe(1);
    expect(s.profile.display_name).toBe("Workspace owner");
    expect(s.notifications.email_on_high_risk).toBe(true);
    expect(s.updated_at).toBe(0);
  });

  it("merges patches and persists to disk", async () => {
    const next = await store.writeSettings({
      profile: { display_name: "Sanjay", contact_email: "s@example.com" },
      notifications: { email_weekly_digest: false },
    });
    expect(next.profile.display_name).toBe("Sanjay");
    expect(next.profile.contact_email).toBe("s@example.com");
    expect(next.profile.org).toBe(""); // default preserved
    expect(next.notifications.email_weekly_digest).toBe(false);
    expect(next.notifications.email_on_high_risk).toBe(true); // default preserved
    expect(next.updated_at).toBeGreaterThan(0);

    const reread = await store.readSettings();
    expect(reread.profile.display_name).toBe("Sanjay");
    expect(reread.notifications.email_weekly_digest).toBe(false);
  });

  it("rejects malformed email and oversize fields", () => {
    expect(
      store.validatePatch({ profile: { contact_email: "not-an-email" } }),
    ).toMatch(/email/);
    expect(
      store.validatePatch({
        profile: { display_name: "x".repeat(200) },
      }),
    ).toMatch(/too long/);
    expect(
      store.validatePatch({
        // @ts-expect-error testing runtime guard
        notifications: { email_on_high_risk: "yes" },
      }),
    ).toMatch(/boolean/);
    expect(store.validatePatch({ profile: { contact_email: "a@b.co" } })).toBeNull();
    expect(store.validatePatch({})).toBeNull();
  });

  it("wipes managed files and reports what was removed", async () => {
    // seed two managed files
    await store.writeSettings({ profile: { display_name: "n" } });
    await fs.writeFile(path.join(tmp, "runs.jsonl"), '{"id":"x"}\n', "utf8");
    expect(existsSync(path.join(tmp, "settings.json"))).toBe(true);
    expect(existsSync(path.join(tmp, "runs.jsonl"))).toBe(true);

    const report = await store.wipeAllData();
    expect(report.removed).toContain("settings.json");
    expect(report.removed).toContain("runs.jsonl");
    expect(report.missing).toContain("api-keys.json");
    expect(existsSync(path.join(tmp, "settings.json"))).toBe(false);
    expect(existsSync(path.join(tmp, "runs.jsonl"))).toBe(false);
  });

  it("exports a bundle that parses jsonl into arrays", async () => {
    await store.writeSettings({ profile: { display_name: "exporter" } });
    await fs.writeFile(
      path.join(tmp, "runs.jsonl"),
      '{"id":"a"}\n{"id":"b"}\n',
      "utf8",
    );
    const bundle = (await store.exportAllData()) as {
      files: Record<string, unknown>;
      exported_at: string;
    };
    expect(bundle.exported_at).toMatch(/T.*Z$/);
    const runs = bundle.files["runs.jsonl"] as Array<{ id: string }>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.map((r) => r.id)).toEqual(["a", "b"]);
    const settings = bundle.files["settings.json"] as { profile: { display_name: string } };
    expect(settings.profile.display_name).toBe("exporter");
    expect(bundle.files["api-keys.json"]).toBeNull();
  });
});
