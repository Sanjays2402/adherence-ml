import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  formatSecretForDisplay,
  generateTotpSecret,
  hotpCode,
  otpauthUri,
  totpCode,
  verifyTotp,
} from "../lib/totp";

describe("totp", () => {
  it("base32 roundtrips arbitrary bytes", () => {
    const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
    const enc = base32Encode(raw);
     expect(base32Decode(enc).equals(raw)).toBe(true);
  });

  it("matches RFC 4226 HOTP test vectors for the standard secret", () => {
    // RFC 4226 appendix D: ASCII "12345678901234567890"
    const secret = Buffer.from("12345678901234567890", "ascii");
    expect(hotpCode(secret, 0)).toBe("755224");
    expect(hotpCode(secret, 1)).toBe("287082");
    expect(hotpCode(secret, 5)).toBe("254676");
    expect(hotpCode(secret, 9)).toBe("520489");
  });

  it("matches RFC 6238 TOTP test vectors at known timestamps (SHA1)", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    const secretB32 = base32Encode(secret);
    // T = 59s -> "94287082" (8 digits); we use 6 digits so take last 6.
    expect(totpCode(secretB32, 59 * 1000, 30, 6)).toBe("287082");
    expect(totpCode(secretB32, 1111111109 * 1000, 30, 6)).toBe("081804");
  });

  it("verifyTotp accepts the current code and rejects garbage", () => {
    const { base32 } = generateTotpSecret();
    const now = Date.now();
    const code = totpCode(base32, now);
    expect(verifyTotp(base32, code, now)).toBe(true);
    expect(verifyTotp(base32, "000000", now)).toBe(false);
    expect(verifyTotp(base32, "abcdef", now)).toBe(false);
    expect(verifyTotp(base32, "", now)).toBe(false);
    expect(verifyTotp(base32, "12345", now)).toBe(false); // wrong length
  });

  it("verifyTotp tolerates +/- 1 step of clock drift", () => {
    const { base32 } = generateTotpSecret();
    const t = 1_700_000_000_000;
    const prev = totpCode(base32, t - 30_000);
    const next = totpCode(base32, t + 30_000);
    expect(verifyTotp(base32, prev, t)).toBe(true);
    expect(verifyTotp(base32, next, t)).toBe(true);
    // Two steps away should fail.
    const tooFar = totpCode(base32, t - 90_000);
    expect(verifyTotp(base32, tooFar, t)).toBe(false);
  });

  it("otpauthUri encodes issuer + account + secret", () => {
    const uri = otpauthUri({
      secretBase32: "JBSWY3DPEHPK3PXP",
      accountName: "alice@example.com",
      issuer: "Adherence",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Adherence:alice%40example.com\?/);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Adherence");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("formatSecretForDisplay groups in 4s", () => {
    expect(formatSecretForDisplay("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });
});
