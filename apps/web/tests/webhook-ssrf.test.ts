/**
 * SSRF guard for outbound webhooks. Proves that the dispatcher refuses to
 * POST to loopback, RFC1918, link-local, and cloud metadata IPs unless the
 * workspace policy explicitly allows private networks, and that host
 * allowlists are honored.
 *
 * Pure unit-level: we inject a fake resolver into checkOutboundUrl so the
 * test is hermetic and does not touch real DNS.
 */
import { describe, it, expect } from "vitest";
import {
  checkOutboundUrl,
  preflightUrl,
  classifyAddress,
  hostMatchesAllowlist,
} from "../lib/webhook-ssrf";

const resolveTo = (addrs: string[]) => async () => addrs;

describe("classifyAddress", () => {
  it("classifies loopback and RFC1918 as private", () => {
    expect(classifyAddress("127.0.0.1")).toBe("private");
    expect(classifyAddress("10.0.0.5")).toBe("private");
    expect(classifyAddress("172.16.5.4")).toBe("private");
    expect(classifyAddress("172.31.255.255")).toBe("private");
    expect(classifyAddress("192.168.1.1")).toBe("private");
    expect(classifyAddress("169.254.1.1")).toBe("private");
    expect(classifyAddress("100.64.0.1")).toBe("private");
    expect(classifyAddress("::1")).toBe("private");
    expect(classifyAddress("fc00::1")).toBe("private");
    expect(classifyAddress("fe80::1")).toBe("private");
  });

  it("flags cloud metadata IPs as metadata, not just private", () => {
    expect(classifyAddress("169.254.169.254")).toBe("metadata");
    expect(classifyAddress("100.100.100.200")).toBe("metadata");
    expect(classifyAddress("fd00:ec2::254")).toBe("metadata");
  });

  it("flags reserved/multicast ranges", () => {
    expect(classifyAddress("224.0.0.1")).toBe("reserved");
    expect(classifyAddress("240.0.0.1")).toBe("reserved");
    expect(classifyAddress("0.0.0.0")).toBe("reserved");
    expect(classifyAddress("ff02::1")).toBe("reserved");
  });

  it("treats genuine public IPs as public", () => {
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("1.1.1.1")).toBe("public");
    expect(classifyAddress("140.82.114.4")).toBe("public");
    expect(classifyAddress("2606:4700:4700::1111")).toBe("public");
  });
});

describe("hostMatchesAllowlist", () => {
  it("matches exact host and dotted suffixes", () => {
    expect(hostMatchesAllowlist("hooks.acme.com", ["hooks.acme.com"])).toBe(true);
    expect(hostMatchesAllowlist("hooks.acme.com", [".acme.com"])).toBe(true);
    expect(hostMatchesAllowlist("acme.com", [".acme.com"])).toBe(true);
    expect(hostMatchesAllowlist("acme.com", ["acme.com"])).toBe(true);
    expect(hostMatchesAllowlist("api.acme.com", ["acme.com"])).toBe(true); // suffix form
    expect(hostMatchesAllowlist("evil.com", ["acme.com"])).toBe(false);
    expect(hostMatchesAllowlist("acme.com.evil.com", [".acme.com"])).toBe(false);
  });

  it("treats empty allowlist as 'no restriction'", () => {
    expect(hostMatchesAllowlist("anything.com", [])).toBe(true);
  });
});

describe("checkOutboundUrl: SSRF policy enforcement", () => {
  it("blocks loopback by default", async () => {
    const r = await checkOutboundUrl("https://localhost/cb", {
      resolver: resolveTo(["127.0.0.1"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_address_blocked");
  });

  it("blocks the AWS metadata IP even if allow_private_networks is true", async () => {
    const r = await checkOutboundUrl("http://169.254.169.254/latest/meta-data/", {
      policy: { allow_private_networks: true },
      resolver: resolveTo(["169.254.169.254"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata_address_blocked");
  });

  it("blocks RFC1918 destinations by default and permits them when policy allows", async () => {
    const url = "https://internal.example.test/hook";
    const denied = await checkOutboundUrl(url, { resolver: resolveTo(["10.1.2.3"]) });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("private_address_blocked");

    const allowed = await checkOutboundUrl(url, {
      policy: { allow_private_networks: true },
      resolver: resolveTo(["10.1.2.3"]),
    });
    expect(allowed.ok).toBe(true);
  });

  it("allows public IPs through the default policy", async () => {
    const r = await checkOutboundUrl("https://hooks.example.com/cb", {
      resolver: resolveTo(["140.82.114.4"]),
    });
    expect(r.ok).toBe(true);
  });

  it("blocks the destination if ANY resolved address is private (DNS-rebinding defense)", async () => {
    const r = await checkOutboundUrl("https://mixed.example.com/cb", {
      resolver: resolveTo(["140.82.114.4", "127.0.0.1"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_address_blocked");
  });

  it("rejects URLs with embedded credentials", async () => {
    const r = await checkOutboundUrl("https://attacker:pass@hooks.example.com/cb", {
      resolver: resolveTo(["140.82.114.4"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });

  it("rejects non-http(s) schemes", async () => {
    const r = await checkOutboundUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_protocol");
  });

  it("rejects non-standard ports unless allow_private_networks is on", async () => {
    const r = await checkOutboundUrl("http://hooks.example.com:22/cb", {
      resolver: resolveTo(["140.82.114.4"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_port");
  });

  it("honors the host allowlist: in-list public host allowed, out-of-list rejected", async () => {
    const policy = { host_allowlist: [".acme.com"] };
    const allowed = await checkOutboundUrl("https://hooks.acme.com/cb", {
      policy,
      resolver: resolveTo(["140.82.114.4"]),
    });
    expect(allowed.ok).toBe(true);
    const denied = await checkOutboundUrl("https://evil.com/cb", {
      policy,
      resolver: resolveTo(["140.82.114.4"]),
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("host_not_allowlisted");
  });
});

describe("preflightUrl: synchronous create-time check", () => {
  it("rejects literal private IPs at create time without DNS", () => {
    expect(preflightUrl("http://127.0.0.1/cb").ok).toBe(false);
    expect(preflightUrl("http://10.0.0.1/cb").ok).toBe(false);
    expect(preflightUrl("http://192.168.1.1/cb").ok).toBe(false);
    expect(preflightUrl("http://169.254.169.254/cb").ok).toBe(false);
  });

  it("accepts public IP literals", () => {
    expect(preflightUrl("https://8.8.8.8/cb").ok).toBe(true);
  });

  it("rejects FTP and javascript: schemes", () => {
    expect(preflightUrl("ftp://example.com/x").ok).toBe(false);
    expect(preflightUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("permits literal private IPs when policy allows private networks", () => {
    expect(preflightUrl("http://10.0.0.5/cb", { allow_private_networks: true }).ok).toBe(true);
  });

  it("still blocks metadata IPs even with allow_private_networks", () => {
    const r = preflightUrl("http://169.254.169.254/cb", { allow_private_networks: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("metadata_address_blocked");
  });
});
