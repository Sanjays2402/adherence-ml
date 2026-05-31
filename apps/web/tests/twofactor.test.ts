import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = mkdtempSync(path.join(os.tmpdir(), "adh-2fa-"));
process.env.ADHERENCE_DATA_DIR = tmp;
process.env.ADHERENCE_SESSION_SECRET = "test-secret-must-be-at-least-16-chars";

const users = await import("../lib/users-store");
const totp = await import("../lib/totp");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("2FA store flow", () => {
  let userId: string;
  let secret: string;
  const codes = users.generateRecoveryCodes(4);

  beforeAll(async () => {
    const u = await users.getOrCreateUserByEmail("twofa@example.com");
    userId = u.id;
    expect(users.hasTotpEnabled(u)).toBe(false);
  });

  it("setPendingTotpSecret stores secret but keeps 2FA disabled", async () => {
    const gen = totp.generateTotpSecret();
    secret = gen.base32;
    const u = await users.setPendingTotpSecret(userId, secret);
    expect(u?.totp_secret).toBe(secret);
    expect(u?.totp_enabled).toBe(false);
    expect(users.hasTotpEnabled(u)).toBe(false);
  });

  it("enableTotp flips the flag and stores hashed recovery codes", async () => {
    const u = await users.enableTotp(userId, codes);
    expect(u?.totp_enabled).toBe(true);
    expect(users.hasTotpEnabled(u)).toBe(true);
    expect(u?.recovery_code_hashes?.length).toBe(codes.length);
    // Plaintext is never persisted.
    for (const c of codes) expect(u?.recovery_code_hashes).not.toContain(c);
  });

  it("verifyTotp accepts a freshly minted code for the stored secret", () => {
    const code = totp.totpCode(secret);
    expect(totp.verifyTotp(secret, code)).toBe(true);
  });

  it("consumeRecoveryCode succeeds once then fails on reuse", async () => {
    const one = codes[0];
    expect(await users.consumeRecoveryCode(userId, one)).toBe(true);
    expect(await users.consumeRecoveryCode(userId, one)).toBe(false);
    const u = await users.getUserById(userId);
    expect(u?.recovery_code_hashes?.length).toBe(codes.length - 1);
  });

  it("disableTotp clears secret, codes, and enabled flag", async () => {
    const u = await users.disableTotp(userId);
    expect(u?.totp_enabled).toBe(false);
    expect(u?.totp_secret).toBeFalsy();
    expect(u?.recovery_code_hashes?.length ?? 0).toBe(0);
    expect(users.hasTotpEnabled(u)).toBe(false);
  });
});
