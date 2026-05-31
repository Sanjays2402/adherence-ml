/**
 * In-process ring buffer for CSP violation reports.
 *
 * We accept both the legacy `application/csp-report` envelope (CSP Level 2)
 * and the modern `application/reports+json` envelope (Reporting API used
 * by Chromium and Firefox for `report-to`). Both shapes are normalised
 * into a single `CspReport` row that the dashboard can render.
 *
 * Reports are stored in memory only. They are user-controlled untrusted
 * input (any visitor on the public origin can POST one), so we cap size,
 * truncate long fields, and never echo them in a way that lets a reporter
 * inject HTML into the admin UI. For long-term retention pipe these into
 * the SIEM drain (every report is logged via `logger.warn` for ingest).
 *
 * Hard cap: ~512 entries (~32 KiB sustained). Once full the oldest entry
 * is evicted. This is deliberately bounded so a misbehaving page that
 * fires thousands of violations per second cannot OOM the dashboard pod.
 */
import { randomUUID } from "node:crypto";

export interface CspReport {
  id: string;
  received_at: number; // epoch ms
  source_ip: string | null;
  user_agent: string | null;
  document_uri: string | null;
  referrer: string | null;
  violated_directive: string | null;
  effective_directive: string | null;
  original_policy_excerpt: string | null;
  blocked_uri: string | null;
  source_file: string | null;
  line_number: number | null;
  column_number: number | null;
  disposition: "enforce" | "report" | null;
  status_code: number | null;
  /** Envelope kind we received: legacy csp-report or modern reports+json. */
  envelope: "csp-report" | "report-to" | "unknown";
}

const MAX = 512;
const ring: CspReport[] = [];

const MAX_STR = 512;

function clip(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s.length === 0) return null;
  return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}...` : s;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function disposition(v: unknown): "enforce" | "report" | null {
  return v === "enforce" || v === "report" ? v : null;
}

/**
 * Normalise a CSP Level 2 envelope.
 *
 *   { "csp-report": { "document-uri": ..., "violated-directive": ..., ... } }
 */
function fromCspReport(body: Record<string, unknown>): Partial<CspReport> {
  const r = (body["csp-report"] ?? {}) as Record<string, unknown>;
  return {
    document_uri: clip(r["document-uri"]),
    referrer: clip(r["referrer"]),
    violated_directive: clip(r["violated-directive"]),
    effective_directive: clip(r["effective-directive"]),
    original_policy_excerpt: clip(r["original-policy"]),
    blocked_uri: clip(r["blocked-uri"]),
    source_file: clip(r["source-file"]),
    line_number: num(r["line-number"]),
    column_number: num(r["column-number"]),
    disposition: disposition(r["disposition"]),
    status_code: num(r["status-code"]),
    envelope: "csp-report",
  };
}

/**
 * Normalise a Reporting API envelope. Browsers POST an array of reports;
 * we extract every entry whose `type === "csp-violation"`.
 *
 *   [{ "type": "csp-violation", "body": { "documentURL": ..., "effectiveDirective": ..., ... } }]
 */
function fromReportTo(entry: Record<string, unknown>): Partial<CspReport> {
  const body = (entry["body"] ?? {}) as Record<string, unknown>;
  return {
    document_uri: clip(body["documentURL"]),
    referrer: clip(body["referrer"]),
    violated_directive: clip(body["effectiveDirective"]),
    effective_directive: clip(body["effectiveDirective"]),
    original_policy_excerpt: clip(body["originalPolicy"]),
    blocked_uri: clip(body["blockedURL"]),
    source_file: clip(body["sourceFile"]),
    line_number: num(body["lineNumber"]),
    column_number: num(body["columnNumber"]),
    disposition: disposition(body["disposition"]),
    status_code: num(body["statusCode"]),
    envelope: "report-to",
  };
}

export interface IngestOptions {
  source_ip: string | null;
  user_agent: string | null;
  /** Raw parsed JSON from the request body. */
  body: unknown;
}

/**
 * Parse and persist a batch of CSP reports. Returns the rows that were
 * stored so the caller can log structured fields without re-parsing.
 */
export function ingest({ source_ip, user_agent, body }: IngestOptions): CspReport[] {
  const stored: CspReport[] = [];

  const push = (partial: Partial<CspReport>) => {
    const row: CspReport = {
      id: randomUUID(),
      received_at: Date.now(),
      source_ip,
      user_agent: clip(user_agent),
      document_uri: null,
      referrer: null,
      violated_directive: null,
      effective_directive: null,
      original_policy_excerpt: null,
      blocked_uri: null,
      source_file: null,
      line_number: null,
      column_number: null,
      disposition: null,
      status_code: null,
      envelope: "unknown",
      ...partial,
    };
    ring.push(row);
    while (ring.length > MAX) ring.shift();
    stored.push(row);
  };

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if ("csp-report" in obj) {
      push(fromCspReport(obj));
      return stored;
    }
  }

  if (Array.isArray(body)) {
    for (const entry of body) {
      if (
        entry &&
        typeof entry === "object" &&
        (entry as Record<string, unknown>)["type"] === "csp-violation"
      ) {
        push(fromReportTo(entry as Record<string, unknown>));
      }
    }
    if (stored.length > 0) return stored;
  }

  // Unknown shape, still record one row so operators can see traffic.
  push({ envelope: "unknown" });
  return stored;
}

export function list(limit = 100): CspReport[] {
  const n = Math.max(1, Math.min(limit, MAX));
  // Newest first.
  return ring.slice(-n).reverse();
}

export function count(): number {
  return ring.length;
}

export function clear(): void {
  ring.length = 0;
}
