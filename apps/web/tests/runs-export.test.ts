import { describe, expect, it } from "vitest";
import {
  filterRunsForExport,
  type ExportFilters,
} from "../lib/runs-export";
import type { RunRecord } from "../lib/runs-store";

function mk(over: Partial<RunRecord>): RunRecord {
  return {
    id: over.id ?? "r_" + Math.random().toString(36).slice(2, 8),
    created_at: over.created_at ?? Date.now(),
    kind: over.kind ?? "predict",
    title: over.title ?? "untitled",
    summary: over.summary ?? "",
    user_id: over.user_id ?? null,
    latency_ms: over.latency_ms ?? null,
    payload: over.payload ?? {},
    tags: over.tags ?? [],
  };
}

const DAY = 86_400_000;
const T0 = Date.parse("2025-06-01T12:00:00Z");

const fixtures: RunRecord[] = [
  mk({ id: "a", kind: "predict", title: "morning statin", created_at: T0 - 2 * DAY, tags: ["staging"], user_id: "u1" }),
  mk({ id: "b", kind: "cohort", title: "weekly scan", created_at: T0 - 1 * DAY, tags: ["prod"], user_id: "u2", summary: "5000 users" }),
  mk({ id: "c", kind: "predict", title: "evening dose", created_at: T0, tags: ["prod", "vip"], user_id: "u1" }),
  mk({ id: "d", kind: "demo", title: "marketing demo", created_at: T0 + 1 * DAY, tags: [], user_id: null }),
];

function ids(rows: RunRecord[]): string[] {
  return rows.map((r) => r.id).sort();
}

describe("filterRunsForExport", () => {
  it("returns everything when no filters set", () => {
    expect(ids(filterRunsForExport(fixtures, {}))).toEqual(["a", "b", "c", "d"]);
  });

  it("filters by kind", () => {
    expect(ids(filterRunsForExport(fixtures, { kind: "predict" }))).toEqual([
      "a",
      "c",
    ]);
  });

  it("treats kind=all as no kind filter", () => {
    expect(ids(filterRunsForExport(fixtures, { kind: "all" }))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("filters by date range inclusive on both ends", () => {
    const f: ExportFilters = { from: T0 - 1 * DAY, to: T0 };
    expect(ids(filterRunsForExport(fixtures, f))).toEqual(["b", "c"]);
  });

  it("filters by exact tag, case-insensitive", () => {
    expect(ids(filterRunsForExport(fixtures, { tag: "PROD" }))).toEqual([
      "b",
      "c",
    ]);
  });

  it("filters by user_id exact match", () => {
    expect(ids(filterRunsForExport(fixtures, { user_id: "u1" }))).toEqual([
      "a",
      "c",
    ]);
  });

  it("free-text q searches title, summary, user, and tags", () => {
    expect(ids(filterRunsForExport(fixtures, { q: "5000" }))).toEqual(["b"]);
    expect(ids(filterRunsForExport(fixtures, { q: "vip" }))).toEqual(["c"]);
    expect(ids(filterRunsForExport(fixtures, { q: "u2" }))).toEqual(["b"]);
  });

  it("combines filters with AND semantics", () => {
    const out = filterRunsForExport(fixtures, {
      kind: "predict",
      tag: "prod",
      from: T0 - 12 * 3600_000,
    });
    expect(ids(out)).toEqual(["c"]);
  });
});
