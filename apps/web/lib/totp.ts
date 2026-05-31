/**
 * RFC 6238 TOTP with RFC 4226 HOTP, zero dependencies.
 *
 * Default parameters match Google Authenticator / 1Password / Authy:
 *   digits=6, period=30s, algorithm=SHA1.
 *
 * Used by the 2FA flow in lib/users-store.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode bytes as RFC 4648 base32 (no padding by default; OTP libs accept either). */
export function base32Encode(buf: Buffer, withPadding = false): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  if (withPadding) {
    while (out.length % 8 !== 0) out += "=";
  }
  return out;
}

/** Decode a base32 string back to bytes. Tolerant of casing, spaces, padding. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/g, "").replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 char");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** Generate a new TOTP secret (20 bytes = 160 bits, RFC 4226 recommended). */
export function generateTotpSecret(): { base32: string; bytes: Buffer } {
  const bytes = randomBytes(20);
  return { base32: base32Encode(bytes), bytes };
}

/** Build an otpauth:// URI for QR display. */
export function otpauthUri(opts: {
  secretBase32: string;
  accountName: string;
  issuer: string;
  digits?: number;
  period?: number;
}): string {
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  const issuer = encodeURIComponent(opts.issuer);
  const label = `${issuer}:${encodeURIComponent(opts.accountName)}`;
  const params = new URLSearchParams({
    secret: opts.secretBase32.replace(/=+$/g, ""),
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Compute a single HOTP code for the given counter. */
export function hotpCode(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  // counter is a 64-bit unsigned int; JS numbers are safe up to 2^53.
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const slice = mac.subarray(offset, offset + 4);
  const code =
    ((slice[0] & 0x7f) << 24) |
    ((slice[1] & 0xff) << 16) |
    ((slice[2] & 0xff) << 8) |
    (slice[3] & 0xff);
  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, "0");
}

/** Compute the current TOTP code. */
export function totpCode(
  secretBase32: string,
  whenMs: number = Date.now(),
  period = 30,
  digits = 6,
): string {
  const counter = Math.floor(whenMs / 1000 / period);
  return hotpCode(base32Decode(secretBase32), counter, digits);
}

/** Constant-time string equality. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a user-submitted TOTP code. Allows +/- 1 step of clock drift
 * to handle phones with slightly off clocks. Returns true on match.
 */
export function verifyTotp(
  secretBase32: string,
  submitted: string,
  whenMs: number = Date.now(),
  period = 30,
  digits = 6,
  window = 1,
): boolean {
  if (!secretBase32 || !submitted) return false;
  const trimmed = submitted.trim().replace(/\s+/g, "");
  if (!/^\d+$/.test(trimmed) || trimmed.length !== digits) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(whenMs / 1000 / period);
  for (let i = -window; i <= window; i++) {
    if (safeEqual(hotpCode(secret, counter + i, digits), trimmed)) {
      return true;
    }
  }
  return false;
}

/** Format a secret in human-friendly 4-char groups for manual entry. */
export function formatSecretForDisplay(b32: string): string {
  const clean = b32.replace(/=+$/g, "").toUpperCase();
  return clean.match(/.{1,4}/g)?.join(" ") ?? clean;
}
