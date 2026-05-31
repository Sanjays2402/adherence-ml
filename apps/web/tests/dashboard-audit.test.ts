/**
 * Tests for the dashboard audit log: hash chain linkage, filters, tamper detect.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "audit-vitest-"));

beforeAll(() => {
  process.env.ADHERENCE_DATA_DIR = tmp;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  const logPath = path.join(tmp, "dashboard-audit.jsonl");
  try {
    writeFileSync(logPath, "");
  } catch {
    /* ignore */
  }
  const mod = await import("../lib/dashboard-audit");
  mod._resetForTests();
});

describe("dashboard audit log", () => {
  it("records entries with linked hash chain and reports chain_valid", async () => {
    const { recordAudit, listAudit } = await import("../lib/dashboard-audit");

    const a = await recordAudit({
      action: "settings.patch",
      target: "workspace.settings",
      actor: { user_id: "u1", email: "a@example.com" },
      metadata: { fields: ["profile.org"] },
    });
    const b = await recordAudit({
      action: "settings.export",
      target: "workspace.bundle",
      actor: { user_id: "u1", email: "a@example.com" },
    });
    const c = await recordAudit({
      action: "settings.wipe",
      target: "workspace.bundle",
      outcome: "denied",
      actor: { user_id: "u2", email: "b@example.com" },
    });

    expect(a.prev_hash).toBe("0".repeat(64));
    expect(b.prev_hash).toBe(a.hash);
    expect(c.prev_hash).toBe(b.hash);

    const res = await listAudit({ limit: 50 });
    expect(res.total).toBe(3);
    expect(res.items).toHaveLength(3);
    expect(res.chain_valid).toBe(true);
    expect(res.items[0]!.action).toBe("settings.wipe");
    expect(res.tip_hash).toBe(c.hash);
  });

  it("filters by action and outcome", async () => {
    const { recordAudit, listAudit } = await import("../lib/dashboard-audit");
    await recordAudit({ action: "settings.patch" });
    await recordAudit({ action: "settings.wipe", outcome: "denied" });
    await recordAudit({ action: "settings.wipe", outcome: "success" });

    const denied = await listAudit({ outcome: "denied" });
    expect(denied.items).toHaveLength(1);
    expect(denied.items[0]!.action).toBe("settings.wipe");

    const wipes = await listAudit({ action: "settings.wipe" });
    expect(wipes.items).toHaveLength(2);
  });

  it("detects tampering by flipping chain_valid to false", async () => {
    const { recordAudit, listAudit } = await import("../lib/dashboard-audit");
    await recordAudit({ action: "settings.patch" });
    await recordAudit({ action: "settings.export" });
    await recordAudit({ action: "settings.wipe" });

    const logPath = path.join(tmp, "dashboard-audit.jsonl");
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    const middle = JSON.parse(lines[1]!);
    middle.metadata = { evil: true };
    lines[1] = JSON.stringify(middle);
    writeFileSync(logPath, lines.join("\n") + "\n");

    const res = await listAudit({});
    expect(res.chain_valid).toBe(false);
  });
});
