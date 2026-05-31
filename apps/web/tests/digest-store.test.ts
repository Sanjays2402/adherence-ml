import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-digest-"));
process.env.ADHERENCE_DATA_DIR = tmp;

const digest = await import("../lib/digest-store");
const runs = await import("../lib/runs-store");
type RunRecord = import("../lib/runs-store").RunRecord;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function mk(over: Partial<RunRecord>): RunRecord {
  return {
    id: over.id ?? Math.random().toString(36).slice(2, 10),
    created_at: over.created_at ?? NOW,
    kind: over.kind ?? "predict",
    title: over.title ?? "untitled",
    summary: over.summary ?? "",
    user_id: over.user_id ?? null,
    latency_ms: over.latency_ms ?? null,
    payload: over.payload ?? {},
    tags: over.tags ?? [],
    share_token: null,
    shared_at: null,
  };
}

beforeEach(async () => {
  for (const f of ["runs.jsonl", "digest-sent.json", "settings.json"]) {
    const p = path.join(tmp, f);
    if (existsSync(p)) await fs.rm(p);
  }
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("digest-store.buildDigest", () => {
  it("returns zeroes on empty input", () => {
    const p = digest.buildDigest([], NOW);
    expect(p.runs_total).toBe(0);
    expect(p.runs_prev_week).toBe(0);
    expect(p.delta_pct).toBe(0);
    expect(p.by_kind).toEqual([]);
    expect(p.by_day).toHaveLength(7);
    expect(p.top_tags).toEqual([]);
    expect(p.window_end - p.window_start).toBe(7 * DAY);
  });

  it("partitions runs into current vs prior week and computes delta", () => {
    const data = [
      // current week (within last 7 days)
      mk({ id: "a", kind: "predict", created_at: NOW - 1 * DAY, tags: ["prod", "high"] }),
      mk({ id: "b", kind: "predict", created_at: NOW - 2 * DAY, tags: ["prod"] }),
      mk({ id: "c", kind: "cohort", created_at: NOW - 3 * DAY, tags: ["high"] }),
      mk({ id: "d", kind: "demo", created_at: NOW - 6 * DAY }),
      // prior week
      mk({ id: "e", kind: "predict", created_at: NOW - 8 * DAY }),
      mk({ id: "f", kind: "predict", created_at: NOW - 13 * DAY }),
      // outside both windows
      mk({ id: "g", kind: "predict", created_at: NOW - 30 * DAY }),
    ];
    const p = digest.buildDigest(data, NOW);
    expect(p.runs_total).toBe(4);
    expect(p.runs_prev_week).toBe(2);
    expect(p.delta_pct).toBe(100); // (4-2)/2*100
    expect(p.by_kind[0].kind).toBe("predict");
    expect(p.by_kind[0].count).toBe(2);
    const tagMap = new Map(p.top_tags.map((t) => [t.tag, t.count]));
    expect(tagMap.get("prod")).toBe(2);
    expect(tagMap.get("high")).toBe(2);
    expect(p.recent_titles).toHaveLength(4);
    expect(p.recent_titles[0].id).toBe("a"); // most recent
  });

  it("renders inline-styled HTML containing the headline number", async () => {
    const p = digest.buildDigest(
      [mk({ id: "x", kind: "predict", created_at: NOW - 1 * DAY, title: "morning sweep" })],
      NOW,
    );
    const html = digest.renderDigestHtml(p, { recipient: "ops@example.com", appUrl: "https://app.test" });
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain("1 runs this week");
    expect(html).toContain("morning sweep");
    expect(html).toContain("https://app.test/history/x");
    expect(html).toContain("ops@example.com");
    // basic sanitization: no <script> appearing from inputs
    expect(html).not.toMatch(/<script/i);
  });

  it("persists sends to the digest-sent log and reads them back", async () => {
    await runs.appendRun(mk({ id: "r1", created_at: NOW - 1 * DAY }));
    const payload = await digest.currentDigest(NOW);
    expect(payload.runs_total).toBe(1);
    const rec = await digest.logSend("foo@example.com", payload, "logged");
    expect(rec.to).toBe("foo@example.com");
    const list = await digest.listSent();
    expect(list).toHaveLength(1);
    expect(list[0].to).toBe("foo@example.com");
    expect(list[0].runs_total).toBe(1);
  });
});
