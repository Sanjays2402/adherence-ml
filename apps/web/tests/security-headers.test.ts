/**
 * Security headers contract tests.
 *
 * Locks in the exact set of HTTP security headers procurement reviewers
 * expect (OWASP secure headers, SOC2 CC6, ISO 27001 A.13.1). Any change to
 * lib/security-headers.ts must be reflected here so we never silently
 * regress to an empty CSP or drop HSTS.
 */
import { describe, expect, it } from "vitest";
import {
  buildSecurityHeaders,
  isApiPath,
  isPublicSharePath,
  newNonce,
  shouldEnableHsts,
} from "@/lib/security-headers";

describe("security headers", () => {
  it("emits the full OWASP baseline for HTML responses", () => {
    const h = buildSecurityHeaders({ nonce: "abc123", isApi: false, hsts: true });
    expect(h["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(h["Content-Security-Policy"]).toContain("'nonce-abc123'");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy"]).toContain("base-uri 'self'");
    expect(h["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["Permissions-Policy"]).toContain("microphone=()");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(h["Strict-Transport-Security"]).toContain("max-age=63072000");
    expect(h["Strict-Transport-Security"]).toContain("includeSubDomains");
    expect(h["Strict-Transport-Security"]).toContain("preload");
    expect(h["X-Permitted-Cross-Domain-Policies"]).toBe("none");
  });

  it("uses a tight CSP and no frame ancestors for API responses", () => {
    const h = buildSecurityHeaders({ nonce: "n", isApi: true, hsts: true });
    expect(h["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(h["Content-Security-Policy"]).not.toContain("'nonce-");
    expect(h["X-Frame-Options"]).toBe("DENY");
  });

  it("relaxes frame-ancestors for public share viewer only", () => {
    const html = buildSecurityHeaders({ nonce: "n", isApi: false });
    expect(html["X-Frame-Options"]).toBe("DENY");

    const share = buildSecurityHeaders({ nonce: "n", isApi: false, isPublicShare: true });
    expect(share["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(share["Content-Security-Policy"]).toContain("frame-ancestors 'self' *");
    expect(share["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
  });

  it("omits HSTS when caller asks (local dev)", () => {
    const h = buildSecurityHeaders({ nonce: "n", isApi: false, hsts: false });
    expect(h["Strict-Transport-Security"]).toBeUndefined();
  });

  it("extends connect-src safely and rejects junk values", () => {
    const h = buildSecurityHeaders({
      nonce: "n",
      isApi: false,
      hsts: true,
      extraConnectSrc: "https://telemetry.acme.com, https://api.acme.com,javascript:alert(1)",
    });
    const csp = h["Content-Security-Policy"];
    expect(csp).toContain("https://telemetry.acme.com");
    expect(csp).toContain("https://api.acme.com");
    expect(csp).not.toContain("alert(1)");
  });

  it("classifies api and share paths", () => {
    expect(isApiPath("/api/foo")).toBe(true);
    expect(isApiPath("/v1/predict")).toBe(true);
    expect(isApiPath("/scim/v2/Users")).toBe(true);
    expect(isApiPath("/settings")).toBe(false);
    expect(isPublicSharePath("/share/abc")).toBe(true);
    expect(isPublicSharePath("/shared")).toBe(false);
  });

  it("enables HSTS in production only by default", () => {
    expect(shouldEnableHsts({ NODE_ENV: "production" })).toBe(true);
    expect(shouldEnableHsts({ NODE_ENV: "development" })).toBe(false);
    expect(shouldEnableHsts({ NODE_ENV: "production", ADHERENCE_DISABLE_HSTS: "1" })).toBe(false);
  });

  it("mints unique nonces of the expected length", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(a).not.toBe(b);
  });
});
