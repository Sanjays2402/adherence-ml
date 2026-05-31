/**
 * Real DNS TXT verification for workspace domain ownership.
 *
 * Enterprise buyers won't accept "trust the operator" for domain claims.
 * When a workspace owner claims a domain, we issue a token and ask them
 * to publish a TXT record at `_adherence-ml-verify.<domain>` containing
 * `adherence-ml-verify=<token>`. This module performs the live lookup
 * using Node's stub resolver and reports a structured result.
 *
 * The resolver is injectable so tests don't hit the real network and so
 * deployments can plug in their own resolver (e.g. a doh client) without
 * touching call sites.
 */
import { promises as dns } from "node:dns";

export const VERIFICATION_HOST_PREFIX = "_adherence-ml-verify";
export const VERIFICATION_VALUE_PREFIX = "adherence-ml-verify=";

export type DnsVerifyResult =
  | { ok: true; matched: string }
  | { ok: false; reason: "txt_not_found" | "token_mismatch_dns" | "dns_lookup_failed"; detail?: string };

/**
 * A resolver that returns the TXT chunks for a hostname. Each entry is an
 * array of strings because a single TXT record can span multiple
 * 255-byte chunks that must be concatenated before comparison.
 */
export type TxtResolver = (host: string) => Promise<string[][]>;

const defaultResolver: TxtResolver = async (host) => {
  return dns.resolveTxt(host);
};

let activeResolver: TxtResolver = defaultResolver;

/** Override the resolver used by {@link verifyDomainTxt}. Tests only. */
export function __setTxtResolverForTests(resolver: TxtResolver | null): void {
  activeResolver = resolver ?? defaultResolver;
}

export function verificationHost(domain: string): string {
  return `${VERIFICATION_HOST_PREFIX}.${domain}`;
}

export function expectedTxtValue(token: string): string {
  return `${VERIFICATION_VALUE_PREFIX}${token}`;
}

/**
 * Look up the verification TXT records for `domain` and check whether any
 * of them carry the expected token. Returns a discriminated result; never
 * throws on DNS failure.
 */
export async function verifyDomainTxt(
  domain: string,
  token: string,
): Promise<DnsVerifyResult> {
  const host = verificationHost(domain);
  const expected = expectedTxtValue(token);
  let records: string[][];
  try {
    records = await activeResolver(host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { ok: false, reason: "txt_not_found", detail: code };
    }
    return {
      ok: false,
      reason: "dns_lookup_failed",
      detail: code || (err instanceof Error ? err.message : String(err)),
    };
  }
  if (!records || records.length === 0) {
    return { ok: false, reason: "txt_not_found" };
  }
  for (const chunks of records) {
    const joined = (chunks ?? []).join("").trim();
    if (joined === expected) {
      return { ok: true, matched: joined };
    }
  }
  // We found TXT records at the verification host but none carried our token.
  return { ok: false, reason: "token_mismatch_dns" };
}
