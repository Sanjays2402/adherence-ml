/**
 * Enterprise dry-run helper.
 *
 * Every destructive endpoint (DELETE primarily) checks this helper to decide
 * whether to actually perform the mutation or just return a preview of what
 * would happen. Enterprise procurement teams require this for change-control
 * review: an operator can preview the blast radius of a destructive call
 * without committing it, and the API itself enforces that no state is
 * modified in dry-run mode.
 *
 * Triggers (any of):
 *   - query string ?dry_run=true   (also: 1, yes, on)
 *   - header X-Dry-Run: true       (also: 1, yes, on)
 *
 * The helper is intentionally tiny and dependency-free so it can be imported
 * into every route handler with zero overhead.
 */
import type { NextRequest, NextResponse } from "next/server";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export interface DryRunPreview {
  /** Short identifier of the resource type, e.g. "api_key", "run". */
  resource: string;
  /** Stable identifier of the resource being targeted. */
  id: string;
  /** Human-readable summary of what would happen. */
  summary: string;
  /**
   * Optional cascade list: ids/labels of related rows that would be removed
   * or modified. Keep this stable and bounded; truncate to ~50 items.
   */
  cascade?: Array<{ resource: string; id: string; label?: string }>;
  /** Optional structured before-image, for audit/diff display. */
  before?: Record<string, unknown>;
}

/**
 * Inspect a request and return true if dry-run mode was requested.
 * Safe to call with a plain Request or NextRequest.
 */
export function isDryRun(req: Request | NextRequest): boolean {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("dry_run");
    if (q && TRUTHY.has(q.toLowerCase())) return true;
  } catch {
    /* fall through */
  }
  const h = req.headers.get("x-dry-run");
  if (h && TRUTHY.has(h.trim().toLowerCase())) return true;
  return false;
}

/**
 * Decorate any JSON NextResponse so downstream callers can detect that the
 * response came from dry-run mode without parsing the body. Use this around
 * the NextResponse.json(...) returned by your handler.
 */
export function withDryRunHeaders<T extends NextResponse>(res: T): T {
  res.headers.set("x-dry-run", "true");
  res.headers.set("cache-control", "no-store");
  return res;
}

/**
 * Build the canonical JSON shape for a dry-run preview response body.
 * Routes pass this to NextResponse.json(...) so consumers always see the
 * same envelope regardless of which resource was previewed.
 */
export function dryRunBody(preview: DryRunPreview) {
  return {
    dry_run: true,
    would: "delete",
    preview: {
      resource: preview.resource,
      id: preview.id,
      summary: preview.summary,
      cascade: preview.cascade ?? [],
      before: preview.before,
    },
  } as const;
}
