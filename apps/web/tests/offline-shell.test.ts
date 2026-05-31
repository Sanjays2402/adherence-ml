/**
 * Offline shell: the static service worker plus the /offline fallback are
 * what keep the installed PWA usable when the network drops. Guard the
 * contract so a future refactor cannot silently break it.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

describe("offline shell", () => {
  it("ships a service worker at /sw.js with the expected caching contract", async () => {
    const sw = await fs.readFile(path.join(ROOT, "public", "sw.js"), "utf8");

    // Never cache mutating APIs, otherwise stale predictions ship.
    expect(sw).toMatch(/\/api\//);
    expect(sw).toMatch(/\/v1\//);
    expect(sw).toMatch(/isApiRequest/);

    // Must precache the /offline fallback so navigations have something to
    // serve when fetch rejects.
    expect(sw).toContain("/offline");

    // Lifecycle hooks present.
    expect(sw).toMatch(/addEventListener\(["']install["']/);
    expect(sw).toMatch(/addEventListener\(["']activate["']/);
    expect(sw).toMatch(/addEventListener\(["']fetch["']/);
  });

  it("includes /sw.js in the deployed public assets", async () => {
    const entries = await fs.readdir(path.join(ROOT, "public"));
    expect(entries).toContain("sw.js");
    expect(entries).toContain("manifest.webmanifest");
  });

  it("offline page source has the user-facing fallback copy and links", async () => {
    const src = await fs.readFile(
      path.join(ROOT, "app", "offline", "page.tsx"),
      "utf8",
    );
    expect(src).toMatch(/You are offline/);
    expect(src).toMatch(/href="\/"/); // try-again target
    expect(src).toMatch(/href="\/history"/); // cached pages still work
    // No em-dashes in user-visible copy per house style.
    expect(src.includes("\u2014")).toBe(false);
  });
});
