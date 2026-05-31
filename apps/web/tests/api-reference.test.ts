/**
 * Guards the /docs page: every documented endpoint must point at a real
 * route file on disk so the reference cannot rot, and renderCurl must
 * substitute the host and key placeholders correctly.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { ENDPOINTS, GROUPS, renderCurl } from "../lib/api-reference";

const ROOT = path.resolve(__dirname, "..");

describe("api-reference", () => {
  it("every documented endpoint resolves to a real route file", () => {
    for (const ep of ENDPOINTS) {
      const abs = path.join(ROOT, ep.routeFile);
      expect(existsSync(abs), `missing route file for ${ep.method} ${ep.path}: ${ep.routeFile}`).toBe(true);
    }
  });

  it("every endpoint belongs to a declared group", () => {
    const groupIds = new Set(GROUPS.map((g) => g.id));
    for (const ep of ENDPOINTS) {
      expect(groupIds.has(ep.group), `unknown group on ${ep.id}: ${ep.group}`).toBe(true);
    }
  });

  it("endpoint ids are unique", () => {
    const seen = new Set<string>();
    for (const ep of ENDPOINTS) {
      expect(seen.has(ep.id), `duplicate id ${ep.id}`).toBe(false);
      seen.add(ep.id);
    }
  });

  it("renderCurl substitutes host and key", () => {
    const ep = ENDPOINTS.find((e) => e.id === "keys-me");
    expect(ep).toBeDefined();
    const out = renderCurl(ep!.curl, "https://api.example.com/", "adh_test_123");
    expect(out).toContain("https://api.example.com/v1/keys/me");
    expect(out).toContain("Bearer adh_test_123");
    expect(out).not.toContain("$HOST");
    expect(out).not.toContain("$KEY");
  });

  it("renderCurl falls back to placeholders when inputs are empty", () => {
    const ep = ENDPOINTS.find((e) => e.id === "predict")!;
    const out = renderCurl(ep.curl, "", "");
    expect(out).toContain("$HOST");
    expect(out).toContain("$KEY");
  });

  it("strips trailing slash from host", () => {
    const ep = ENDPOINTS.find((e) => e.id === "runs-list")!;
    const out = renderCurl(ep.curl, "http://localhost:3000/", "k");
    expect(out).not.toContain("3000//");
    expect(out).toContain("http://localhost:3000/v1/runs");
  });
});
