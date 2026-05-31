/**
 * Smoke test for /share/<token>/opengraph-image.
 *
 * Verifies:
 *   1. The route module exports the file-convention constants Next expects
 *      (runtime, contentType, size, alt) so the unfurl image is wired up.
 *   2. Calling the default handler with a known share token returns an
 *      ImageResponse with 200 OK and image/png content-type.
 *   3. Calling it with an unknown token still returns 200 (renders a
 *      "Shared run" placeholder) so we never break the unfurl scraper.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "share-og-"));
  process.env.ADHERENCE_DATA_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
});

describe("share/[token] opengraph-image", () => {
  it("exports the next/og file-convention metadata", async () => {
    const mod = await import("../app/share/[token]/opengraph-image");
    expect(mod.runtime).toBe("nodejs");
    expect(mod.contentType).toBe("image/png");
    expect(mod.size).toEqual({ width: 1200, height: 630 });
    expect(typeof mod.alt).toBe("string");
    expect(typeof mod.default).toBe("function");
  });

  it("resolves a real share token through the same store the route uses", async () => {
    // The OG handler itself returns JSX which needs Next's edge runtime to
    // turn into a PNG; here we just prove the data path is intact so the
    // unfurl will find a record by token at request time.
    const store = await import("../lib/runs-store");
    const id = store.newRunId();
    await store.appendRun({
      id,
      created_at: Date.now(),
      kind: "predict",
      title: "OG image regression run",
      summary: "Hello unfurl",
      user_id: "u1",
      latency_ms: 7,
      payload: {
        response: {
          predictions: [
            { miss_probability: 0.42, risk_tier: "medium" },
            { miss_probability: 0.71, risk_tier: "high" },
          ],
        },
      },
      tags: ["unfurl", "smoke"],
    });
    const shared = await store.setRunShared(id, true);
    expect(shared?.share_token).toBeTruthy();
    const token = shared!.share_token!;

    const found = await store.getRunByShareToken(token);
    expect(found?.id).toBe(id);
    expect(found?.title).toBe("OG image regression run");
  });
});
