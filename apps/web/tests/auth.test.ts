import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-auth-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";

// import AFTER env is set so module-level DATA_DIR resolves correctly
const users = await import("../lib/users-store");
const session = await import("../lib/session");

beforeAll(async () => {
  const f = path.join(tmp, "users.json");
  if (existsSync(f)) await fs.rm(f);
});

afterAll(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  delete process.env.ADHERENCE_DATA_DIR;
  delete process.env.ADHERENCE_SESSION_SECRET;
});

describe("users-store: email validation", () => {
  it("accepts well-formed emails and rejects junk", () => {
    expect(users.isValidEmail("a@b.co")).toBe(true);
    expect(users.isValidEmail("foo.bar+tag@example.com")).toBe(true);
    expect(users.isValidEmail("not-an-email")).toBe(false);
    expect(users.isValidEmail("a@b")).toBe(false);
    expect(users.isValidEmail("")).toBe(false);
  });

  it("normalizes case and whitespace", () => {
    expect(users.normalizeEmail("  FOO@Bar.COM ")).toBe("foo@bar.com");
  });
});

describe("users-store: magic link flow", () => {
  it("creates a user on first successful consume and reuses on subsequent logins", async () => {
    const { token, expires_at } = await users.issueMagicToken("alice@example.com");
    expect(token.length).toBeGreaterThanOrEqual(24);
    expect(expires_at).toBeGreaterThan(Date.now());

    const u1 = await users.consumeMagicToken(token);
    expect(u1).not.toBeNull();
    expect(u1!.email).toBe("alice@example.com");

    const { token: t2 } = await users.issueMagicToken("alice@example.com");
    const u2 = await users.consumeMagicToken(t2);
    expect(u2).not.toBeNull();
    expect(u2!.id).toBe(u1!.id);
  });

  it("rejects replayed, unknown, and empty tokens", async () => {
    const { token } = await users.issueMagicToken("bob@example.com");
    expect(await users.consumeMagicToken(token)).not.toBeNull();
    expect(await users.consumeMagicToken(token)).toBeNull(); // replay
    expect(await users.consumeMagicToken("")).toBeNull();
    expect(await users.consumeMagicToken("garbage-token-not-issued")).toBeNull();
  });
});

describe("session: sign / verify", () => {
  it("round-trips a valid session", () => {
    const fakeUser = {
      id: "u_test123",
      email: "carol@example.com",
      created_at: Date.now(),
      last_login_at: Date.now(),
    };
    const { cookie, expires } = session.buildSession(fakeUser);
    expect(expires.getTime()).toBeGreaterThan(Date.now() + 24 * 3600 * 1000);

    const payload = session.verifySession(cookie);
    expect(payload).not.toBeNull();
    expect(payload!.uid).toBe("u_test123");
    expect(payload!.eml).toBe("carol@example.com");
  });

  it("rejects tampered, malformed, and expired sessions", () => {
    const raw = session.signSession({
      uid: "u_x",
      eml: "x@x.io",
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const [body, sig] = raw.split(".");
    const tampered = body + "." + sig.split("").reverse().join("");
    expect(session.verifySession(tampered)).toBeNull();
    expect(session.verifySession(undefined)).toBeNull();
    expect(session.verifySession("no-dot")).toBeNull();

    const expired = session.signSession({
      uid: "u_x",
      eml: "x@x.io",
      iat: Date.now() - 1000,
      exp: Date.now() - 1,
    });
    expect(session.verifySession(expired)).toBeNull();
  });
});
