/**
 * Outbound webhook SSRF guard.
 *
 * Enterprise customers reject any product whose outbound webhooks can be
 * pointed at internal infra. This module resolves the destination hostname,
 * classifies every returned address, and refuses to dispatch unless the
 * destination is on a publicly routable network (or the workspace owner has
 * explicitly opted in to private targets).
 *
 * It also enforces an optional per-workspace host allowlist so a buyer's
 * security team can pin webhooks to known domains (".acme.com").
 *
 * The blocked address sets cover:
 *   - IPv4 loopback / link-local / private / multicast / broadcast / reserved
 *   - IPv6 loopback (::1), link-local (fe80::/10), unique-local (fc00::/7),
 *     multicast (ff00::/8), IPv4-mapped (::ffff:0:0/96)
 *   - Cloud instance metadata addresses (AWS/GCP/Azure 169.254.169.254,
 *     fd00:ec2::254)
 *
 * Pure functions: no I/O beyond DNS lookup, no external deps, no Next.js
 * imports. Used by webhook-dispatch.ts on every attempt and by
 * webhooks-store.createEndpoint on URL submission.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SsrfPolicy {
  allow_private_networks: boolean;
  host_allowlist: string[];
}

export const DEFAULT_SSRF_POLICY: SsrfPolicy = {
  allow_private_networks: false,
  host_allowlist: [],
};

export interface SsrfCheckOk {
  ok: true;
  host: string;
  addresses: string[];
}

export type SsrfBlockReason =
  | "invalid_url"
  | "bad_protocol"
  | "bad_port"
  | "host_not_allowlisted"
  | "dns_failed"
  | "private_address_blocked"
  | "reserved_address_blocked"
  | "metadata_address_blocked";

export interface SsrfCheckBlocked {
  ok: false;
  reason: SsrfBlockReason;
  detail: string;
}

export type SsrfCheck = SsrfCheckOk | SsrfCheckBlocked;

/** Strictly-blocked instance metadata IPs across major clouds. */
const METADATA_IPS = new Set<string>([
  "169.254.169.254", // AWS, GCP, Azure, DigitalOcean
  "100.100.100.200", // Alibaba Cloud
  "fd00:ec2::254", // AWS IMDS v6
]);

/** Only outbound to web ports unless allow_private_networks is set. */
const DEFAULT_ALLOWED_PORTS = new Set<number>([80, 443]);

function parseIpv4(addr: string): number[] | null {
  if (isIP(addr) !== 4) return null;
  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

function classifyIpv4(addr: string): "public" | "private" | "reserved" | "metadata" {
  if (METADATA_IPS.has(addr)) return "metadata";
  const parts = parseIpv4(addr);
  if (!parts) return "reserved";
  const [a, b, c] = parts;
  if (a === 127) return "private";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a >= 224 && a <= 239) return "reserved";
  if (a >= 240) return "reserved";
  if (a === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  return "public";
}

function normalizeIpv6(addr: string): string {
  return addr.toLowerCase().split("%")[0];
}

function classifyIpv6(addrRaw: string): "public" | "private" | "reserved" | "metadata" {
  const addr = normalizeIpv6(addrRaw);
  if (METADATA_IPS.has(addr)) return "metadata";
  if (addr === "::1" || addr === "::") return "private";
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyIpv4(mapped[1]);
  if (
    addr.startsWith("fe8") ||
    addr.startsWith("fe9") ||
    addr.startsWith("fea") ||
    addr.startsWith("feb")
  ) {
    return "private";
  }
  if (addr.startsWith("fc") || addr.startsWith("fd")) return "private";
  if (addr.startsWith("ff")) return "reserved";
  if (addr.startsWith("100:")) return "reserved";
  return "public";
}

export function classifyAddress(addr: string): "public" | "private" | "reserved" | "metadata" {
  const v = isIP(addr);
  if (v === 4) return classifyIpv4(addr);
  if (v === 6) return classifyIpv6(addr);
  return "reserved";
}

/** Host matches allowlist if it equals an entry or ends with ".entry". */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith(".")) {
      if (h === entry.slice(1) || h.endsWith(entry)) return true;
    } else {
      if (h === entry || h.endsWith("." + entry)) return true;
    }
  }
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;

async function defaultResolver(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

export interface CheckOptions {
  policy?: Partial<SsrfPolicy>;
  resolver?: Resolver;
  allowedPrivatePorts?: number[];
}

export async function checkOutboundUrl(
  url: string,
  opts: CheckOptions = {},
): Promise<SsrfCheck> {
  const policy: SsrfPolicy = {
    allow_private_networks: opts.policy?.allow_private_networks ?? false,
    host_allowlist: opts.policy?.host_allowlist ?? [],
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid_url", detail: "not a valid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "bad_protocol", detail: `protocol ${parsed.protocol} not allowed` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "invalid_url", detail: "userinfo in URL not allowed" };
  }
  const portNum = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { ok: false, reason: "bad_port", detail: `invalid port ${parsed.port}` };
  }
  if (!policy.allow_private_networks) {
    if (!DEFAULT_ALLOWED_PORTS.has(portNum)) {
      return {
        ok: false,
        reason: "bad_port",
        detail: `port ${portNum} not permitted; enable allow_private_networks to use non-standard ports`,
      };
    }
  } else {
    const extra = new Set(opts.allowedPrivatePorts ?? []);
    if (!DEFAULT_ALLOWED_PORTS.has(portNum) && !extra.has(portNum) && (portNum < 1024 || portNum > 65535)) {
      return { ok: false, reason: "bad_port", detail: `port ${portNum} not permitted` };
    }
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "invalid_url", detail: "empty host" };
  if (!hostMatchesAllowlist(host, policy.host_allowlist)) {
    return { ok: false, reason: "host_not_allowlisted", detail: `host ${host} not in workspace allowlist` };
  }
  if (host === "localhost" && !policy.allow_private_networks) {
    return { ok: false, reason: "private_address_blocked", detail: "localhost not allowed" };
  }
  const resolver = opts.resolver ?? defaultResolver;
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (e) {
    return {
      ok: false,
      reason: "dns_failed",
      detail: e instanceof Error ? e.message.slice(0, 200) : "DNS lookup failed",
    };
  }
  if (!addresses.length) {
    return { ok: false, reason: "dns_failed", detail: `no A/AAAA records for ${host}` };
  }
  for (const addr of addresses) {
    const cls = classifyAddress(addr);
    if (cls === "metadata") {
      return { ok: false, reason: "metadata_address_blocked", detail: `${addr} is a cloud metadata IP` };
    }
    if (cls === "reserved") {
      return { ok: false, reason: "reserved_address_blocked", detail: `${addr} is in a reserved range` };
    }
    if (cls === "private" && !policy.allow_private_networks) {
      return {
        ok: false,
        reason: "private_address_blocked",
        detail: `${addr} is on a private network; enable allow_private_networks to use it`,
      };
    }
  }
  return { ok: true, host, addresses };
}

/** Synchronous version for create-time URL validation (no DNS). */
export function preflightUrl(
  url: string,
  policy: Partial<SsrfPolicy> = {},
): { ok: true } | { ok: false; reason: SsrfBlockReason; detail: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid_url", detail: "not a valid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "bad_protocol", detail: `protocol ${parsed.protocol} not allowed` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "invalid_url", detail: "userinfo in URL not allowed" };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "invalid_url", detail: "empty host" };
  if (!hostMatchesAllowlist(host, policy.host_allowlist ?? [])) {
    return { ok: false, reason: "host_not_allowlisted", detail: `host ${host} not in workspace allowlist` };
  }
  if (isIP(host)) {
    const cls = classifyAddress(host);
    if (cls === "metadata") return { ok: false, reason: "metadata_address_blocked", detail: `${host} is a metadata IP` };
    if (cls === "reserved") return { ok: false, reason: "reserved_address_blocked", detail: `${host} is reserved` };
    if (cls === "private" && !(policy.allow_private_networks ?? false)) {
      return { ok: false, reason: "private_address_blocked", detail: `${host} is a private IP` };
    }
  } else if (host === "localhost" && !(policy.allow_private_networks ?? false)) {
    return { ok: false, reason: "private_address_blocked", detail: "localhost not allowed" };
  }
  return { ok: true };
}
