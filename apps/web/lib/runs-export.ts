import type { RunRecord, RunKind } from "@/lib/runs-store";

export interface ExportFilters {
  q?: string;
  kind?: RunKind | "all";
  tag?: string;
  from?: number | null;
  to?: number | null;
  user_id?: string;
}

/** Apply the same filter semantics the /api/runs GET uses, plus date range, tag, user. */
export function filterRunsForExport(
  all: RunRecord[],
  f: ExportFilters,
): RunRecord[] {
  const q = f.q?.trim().toLowerCase();
  const kind = f.kind && f.kind !== "all" ? f.kind : null;
  const tag = f.tag?.trim().toLowerCase();
  const userId = f.user_id?.trim();
  const from = f.from ?? null;
  const to = f.to ?? null;

  return all.filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (userId && (r.user_id ?? "") !== userId) return false;
    if (from !== null && r.created_at < from) return false;
    if (to !== null && r.created_at > to) return false;
    if (tag && !r.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (q) {
      const hay =
        `${r.title} ${r.summary} ${r.user_id ?? ""} ${r.tags.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Parse a date in YYYY-MM-DD or ISO form; returns epoch ms or null. */
export function parseExportDate(raw: string | null, endOfDay: boolean): number | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = Date.parse(raw + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"));
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}
