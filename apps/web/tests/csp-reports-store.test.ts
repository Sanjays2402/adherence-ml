/**
 * CSP report ingest store contract tests. Locks in:
 *   - both browser envelopes (Level 2 csp-report, Reporting API report-to)
 *   - clipping of overlong strings,
 *   - bounded ring buffer (no unbounded growth),
 *   - newest-first listing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clear, count, ingest, list } from "@/lib/csp-reports-store";

afterEach(() => clear());

describe("csp reports store", () => {
  it("normalises the legacy csp-report envelope", () => {
    const stored = ingest({
      source_ip: "203.0.113.7",
      user_agent: "Mozilla/5.0 (test)",
      body: {
        "csp-report": {
          "document-uri": "https://adherence.ml/dashboard",
          "referrer": "https://adherence.ml/login",
          "violated-directive": "script-src",
          "effective-directive": "script-src-elem",
          "original-policy": "default-src 'self'; script-src 'self' 'nonce-xyz'",
          "blocked-uri": "https://evil.example.com/x.js",
          "source-file": "https://adherence.ml/dashboard",
          "line-number": 42,
          "column-number": 17,
          "disposition": "enforce",
          "status-code": 200,
        },
      },
    });
    expect(stored).toHaveLength(1);
    const r = stored[0]!;
    expect(r.envelope).toBe("csp-report");
    expect(r.document_uri).toBe("https://adherence.ml/dashboard");
    expect(r.violated_directive).toBe("script-src");
    expect(r.blocked_uri).toBe("https://evil.example.com/x.js");
    expect(r.line_number).toBe(42);
    expect(r.disposition).toBe("enforce");
    expect(r.source_ip).toBe("203.0.113.7");
    expect(r.user_agent).toBe("Mozilla/5.0 (test)");
  });

  it("normalises the Reporting API report-to envelope and skips non-csp entries", () => {
    const stored = ingest({
      source_ip: null,
      user_agent: null,
      body: [
        {
          type: "csp-violation",
          age: 12,
          url: "https://adherence.ml/runs/42",
          body: {
            documentURL: "https://adherence.ml/runs/42",
            referrer: "https://adherence.ml/runs",
            effectiveDirective: "connect-src",
            originalPolicy: "default-src 'self'",
            blockedURL: "https://exfil.example.com/beacon",
            sourceFile: "https://adherence.ml/_next/static/chunks/main.js",
            lineNumber: "1",
            columnNumber: "9001",
            disposition: "report",
            statusCode: 200,
          },
        },
        { type: "deprecation", body: { id: "noop" } },
        {
          type: "csp-violation",
          body: { documentURL: "https://adherence.ml/login", effectiveDirective: "img-src" },
        },
      ],
    });
    expect(stored).toHaveLength(2);
    expect(stored[0]!.envelope).toBe("report-to");
    expect(stored[0]!.violated_directive).toBe("connect-src");
    expect(stored[0]!.blocked_uri).toBe("https://exfil.example.com/beacon");
    expect(stored[0]!.line_number).toBe(1);
    expect(stored[0]!.column_number).toBe(9001);
    expect(stored[0]!.disposition).toBe("report");
    expect(stored[1]!.violated_directive).toBe("img-src");
  });

  it("clips long strings so a hostile reporter cannot bloat memory", () => {
    const huge = "A".repeat(5000);
    const [row] = ingest({
      source_ip: null,
      user_agent: huge,
      body: {
        "csp-report": {
          "document-uri": huge,
          "blocked-uri": huge,
          "original-policy": huge,
        },
      },
    });
    expect(row!.user_agent!.length).toBeLessThanOrEqual(515);
    expect(row!.document_uri!.length).toBeLessThanOrEqual(515);
    expect(row!.blocked_uri!.length).toBeLessThanOrEqual(515);
    expect(row!.original_policy_excerpt!.endsWith("...")).toBe(true);
  });

  it("caps ring buffer growth and returns newest entries first", () => {
    for (let i = 0; i < 700; i++) {
      ingest({
        source_ip: null,
        user_agent: null,
        body: {
          "csp-report": { "document-uri": `https://x/${i}`, "violated-directive": "img-src" },
        },
      });
    }
    expect(count()).toBeLessThanOrEqual(512);
    const top = list(5);
    expect(top).toHaveLength(5);
    expect(top[0]!.document_uri).toBe("https://x/699");
    expect(top[4]!.document_uri).toBe("https://x/695");
  });

  it("still records an entry for unknown envelopes so traffic is visible", () => {
    const [row] = ingest({
      source_ip: "198.51.100.1",
      user_agent: "curl/8",
      body: { whatever: true },
    });
    expect(row!.envelope).toBe("unknown");
    expect(row!.source_ip).toBe("198.51.100.1");
  });
});
