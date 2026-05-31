import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-sess-rev-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";

const users = await import("../lib/users-store");
const session = await import("../lib/session");

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_SESSION_SECRET;
});

/**
 * Helper to fully reproduce what getSession does, without depending on
 * next/headers cookies(): verify the signed cookie and then enforce the
 * gen check against the latest user record.
 */
async function authenticate(cookie: string) {
  const payload = session.verifySession(cookie);
  if (!payload) return null;
  const u = await users.getUserById(payload.uid);
  if (!u) return null;
  const cookieGen = typeof payload.gen === "number" ? payload.gen : 1;
  if (cookieGen < users.currentSessionGen(u)) return null;
  return { user: u, payload };
}

describe("session revocation: bumpSessionGen invalidates outstanding cookies", () => {
  beforeAll(async () => {
    await users._resetForTests();
  });

  it("a fresh cookie is accepted, then a force-logout-all invalidates it, then a re-minted cookie works again", async () => {
    // Create a real user and mint a cookie for them.
    const { token } = await users.issueMagicToken("dave@example.com");
    const u = await users.consumeMagicToken(token);
    expect(u).not.toBeNull();

    const { cookie: cookieA } = await session.buildSession(u!);
    expect(await authenticate(cookieA)).not.toBeNull();

    // Bump the generation. Old cookie must be rejected immediately.
    const bumped = await users.bumpSessionGen(u!.id);
    expect(bumped).not.toBeNull();
    expect(bumped!.session_gen).toBeGreaterThanOrEqual(2);
    expect(bumped!.sessions_revoked_at).toBeTruthy();

    expect(await authenticate(cookieA)).toBeNull();

    // Re-mint after the bump. New cookie carries the new gen and works.
    const { cookie: cookieB } = await session.buildSession(bumped!);
    const ok = await authenticate(cookieB);
    expect(ok).not.toBeNull();
    expect(ok!.user.id).toBe(u!.id);

    // A second revocation invalidates the previously re-minted cookie too.
    await users.bumpSessionGen(u!.id);
    expect(await authenticate(cookieB)).toBeNull();
  });

  it("legacy cookies without a gen claim still verify until the first revocation", async () => {
    const { token } = await users.issueMagicToken("erin@example.com");
    const u = await users.consumeMagicToken(token);
    expect(u).not.toBeNull();

    // Mint a legacy-shaped cookie by hand (no `gen` claim).
    const legacy = session.signSession({
      uid: u!.id,
      eml: u!.email,
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    expect(await authenticate(legacy)).not.toBeNull();

    // After force-logout-all, the legacy cookie is also rejected.
    await users.bumpSessionGen(u!.id);
    expect(await authenticate(legacy)).toBeNull();
  });
});
