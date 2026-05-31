import { describe, expect, it } from "vitest";
import { renderPdf } from "../lib/pdf";
import { runToPdf } from "../lib/run-pdf";
import type { RunRecord } from "../lib/runs-store";

function mk(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: over.id ?? "r_test123",
    created_at: over.created_at ?? Date.UTC(2025, 0, 15, 9, 30, 0),
    kind: over.kind ?? "predict",
    title: over.title ?? "Patient 42 weekly check",
    summary: over.summary ?? "Adherence risk above prior baseline.",
    user_id: over.user_id ?? "u_demo",
    latency_ms: over.latency_ms ?? 142,
    payload: over.payload ?? { risk: 0.73, features: { refills: 3 } },
    tags: over.tags ?? ["weekly", "high-risk"],
  };
}

describe("pdf renderer", () => {
  it("produces a well formed PDF byte stream", () => {
    const buf = renderPdf([
      { kind: "h1", text: "Hello" },
      { kind: "p", text: "This is a paragraph." },
    ]);
    const head = buf.subarray(0, 8).toString("latin1");
    const tail = buf.subarray(buf.length - 6).toString("latin1");
    expect(head.startsWith("%PDF-1.4")).toBe(true);
    expect(tail).toContain("%%EOF");
    expect(buf.includes(Buffer.from("xref"))).toBe(true);
    expect(buf.includes(Buffer.from("/Type /Catalog"))).toBe(true);
  });

  it("escapes parentheses and backslashes in text", () => {
    const buf = renderPdf([{ kind: "p", text: "weird (token) \\path" }]);
    const ascii = buf.toString("latin1");
    expect(ascii).toContain("\\(token\\)");
    expect(ascii).toContain("\\\\path");
  });
});

describe("runToPdf", () => {
  it("includes title, kind label, and risk score from payload", () => {
    const buf = runToPdf(mk(), { origin: "https://example.test" });
    const ascii = buf.toString("latin1");
    expect(ascii.startsWith("%PDF-1.4")).toBe(true);
    expect(ascii).toContain("Patient 42 weekly check");
    expect(ascii).toContain("Adherence prediction");
    // 0.73 -> 73.0% Elevated band
    expect(ascii).toContain("73.0%");
    expect(ascii).toContain("Elevated");
    expect(ascii).toContain("https://example.test/history/r_test123");
  });

  it("handles runs without a risk score gracefully", () => {
    const buf = runToPdf(mk({ payload: { note: "no risk here" } }));
    const ascii = buf.toString("latin1");
    expect(ascii).toContain("Payload");
    expect(ascii).not.toContain("Risk score");
  });

  it("truncates very large payloads to keep the report single page", () => {
    const huge = { blob: "x".repeat(8000) };
    const buf = runToPdf(mk({ payload: huge }));
    const ascii = buf.toString("latin1");
    expect(ascii).toContain("more chars truncated");
    // Document should still terminate cleanly.
    expect(ascii).toContain("%%EOF");
  });
});
