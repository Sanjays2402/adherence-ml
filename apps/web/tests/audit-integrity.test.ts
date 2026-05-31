/**
 * Audit chain integrity: verifyAuditChain + exportAuditBundle.
 *
 * Covers:
 *  - empty log
 *  - intact chain reports valid + correct tip
 *  - tampered metadata flips chain_valid and reports first_break_index/id
 *  - flipped prev_hash flips chain_valid with prev_hash reason
 *  - corrupt JSONL line is flagged via has_corrupt_lines
 *  - bundle manifest entries_root is sha256 over concatenated entry hashes
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(path.join(tmpdir(), "audit-integrity-"));
const logPath = () => path.join(tmp, "dashboard-audit.jsonl");

beforeAll(() => {
  process.env.ADHERENCE_DATA_DIR = tmp;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  writeFileSync(logPath(), "");
  const mod = await import("../lib/dashboard-audit");
  mod._resetForTests();
});

async function seed() {
  const { recordAudit } = await import("../lib/dashboard-audit");
  await recordAudit({
    action: "settings.patch",
    target: "workspace.settings",
    actor: { user_id: "u1", email: "a@example.com" },
  });
  await recordAudit({
    action: "settings.export",
    target: "workspace.bundle",
    actor: { user_id: "u1", email: "a@example.com" },
  });
  await recordAudit({
    action: "settings.wipe",
    outcome: "denied",
    actor: { user_id: "u2", email: "b@example.com" },
  });
}

describe("verifyAuditChain", () => {
  it("returns an empty-but-valid report when the log file is missing", async () => {
    rmSync(logPath(), { force: true });
    const { verifyAuditChain } = await import("../lib/dashboard-audit");
    const r = await verifyAuditChain();
    expect(r.entries).toBe(0);
    expect(r.chain_valid).toBe(true);
    expect(r.tip_hash).toBeNull();
    expect(r.first_break_index).toBeNull();
    expect(r.first_break_id).toBeNull();
    expect(r.genesis_hash).toMatch(/^0{64}$/);
  });

  it("reports a fully valid chain with correct counts and tip", async () => {
    await seed();
    const { verifyAuditChain } = await import("../lib/dashboard-audit");
    const r = await verifyAuditChain();
    expect(r.entries).toBe(3);
    expect(r.chain_valid).toBe(true);
    expect(r.first_break_index).toBeNull();
    expect(r.tip_hash).not.toBeNull();
    expect((r.tip_hash as string).length).toBe(64);
    expect(r.has_corrupt_lines).toBe(false);
  });

  it("flags a tampered entry and pinpoints first_break_index", async () => {
    await seed();
    const raw = readFileSync(logPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    // tamper with entry at index 1: change the action field, keep its hash
    const second = JSON.parse(lines[1]!) as { action: string };
    second.action = "settings.export.TAMPERED";
    lines[1] = JSON.stringify(second);
    writeFileSync(logPath(), lines.join("\n") + "\n");

    const { verifyAuditChain, _resetForTests } = await import("../lib/dashboard-audit");
    _resetForTests();
    const r = await verifyAuditChain();
    expect(r.chain_valid).toBe(false);
    expect(r.first_break_index).toBe(1);
    expect(r.first_break_reason).toMatch(/hash mismatch/);
    expect(r.first_break_id).toBeTruthy();
  });

  it("flags a broken prev_hash linkage", async () => {
    await seed();
    const raw = readFileSync(logPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const second = JSON.parse(lines[1]!) as { prev_hash: string };
    second.prev_hash = "f".repeat(64);
    lines[1] = JSON.stringify(second);
    writeFileSync(logPath(), lines.join("\n") + "\n");

    const { verifyAuditChain, _resetForTests } = await import("../lib/dashboard-audit");
    _resetForTests();
    const r = await verifyAuditChain();
    expect(r.chain_valid).toBe(false);
    expect(r.first_break_index).toBe(1);
    expect(r.first_break_reason).toMatch(/prev_hash mismatch/);
  });

  it("flags corrupt jsonl lines", async () => {
    await seed();
    const raw = readFileSync(logPath(), "utf8");
    writeFileSync(logPath(), raw + "{not json\n");
    const { verifyAuditChain, _resetForTests } = await import("../lib/dashboard-audit");
    _resetForTests();
    const r = await verifyAuditChain();
    expect(r.has_corrupt_lines).toBe(true);
    expect(r.chain_valid).toBe(false);
  });
});

describe("exportAuditBundle", () => {
  it("returns a bundle whose entries_root recomputes from the entries alone", async () => {
    await seed();
    const { exportAuditBundle } = await import("../lib/dashboard-audit");
    const bundle = await exportAuditBundle({ workspace_id: "ws_demo" });

    expect(bundle.manifest.schema).toBe("adherence.audit.bundle.v1");
    expect(bundle.manifest.workspace_id).toBe("ws_demo");
    expect(bundle.manifest.entry_count).toBe(bundle.entries.length);
    expect(bundle.manifest.hash_algorithm).toBe("sha256");
    expect(bundle.manifest.tip_hash).toBe(
      bundle.entries[bundle.entries.length - 1]!.hash,
    );
    expect(bundle.manifest.head_hash).toBe(bundle.entries[0]!.hash);

    const h = createHash("sha256");
    for (const e of bundle.entries) h.update(e.hash);
    expect(bundle.manifest.entries_root).toBe(h.digest("hex"));
    expect(bundle.report.chain_valid).toBe(true);
  });

  it("produces an empty bundle when the log is empty", async () => {
    rmSync(logPath(), { force: true });
    const { exportAuditBundle } = await import("../lib/dashboard-audit");
    const bundle = await exportAuditBundle();
    expect(bundle.entries).toEqual([]);
    expect(bundle.manifest.entry_count).toBe(0);
    expect(bundle.manifest.tip_hash).toBeNull();
    expect(bundle.manifest.head_hash).toBeNull();
    // sha256 of the empty string
    expect(bundle.manifest.entries_root).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(bundle.report.chain_valid).toBe(true);
  });
});
