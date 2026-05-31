import type { RunRecord, RunKind } from "@/lib/runs-store";

export interface ExportFilters {
  q?: string;
  kind?: RunKind | "all";
  /** Single tag (legacy `tag=` query param). */
  tag?: string;
  /** Multi-tag AND match (case-insensitive). */
  tags?: string[];
  from?: number | null;
  to?: number | null;
  user_id?: string;
}

/** Apply the same filter semantics /api/runs uses, plus date range, tag, user. */
export function filterRunsForExport(
  all: RunRecord[],
  f: ExportFilters,
): RunRecord[] {
  const q = f.q?.trim().toLowerCase();
  const kind = f.kind && f.kind !== "all" ? f.kind : null;
  const tag = f.tag?.trim().toLowerCase();
  const tagsAll = (f.tags ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const userId = f.user_id?.trim();
  const from = f.from ?? null;
  const to = f.to ?? null;

  return all.filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (userId && (r.user_id ?? "") !== userId) return false;
    if (from !== null && r.created_at < from) return false;
    if (to !== null && r.created_at > to) return false;
    if (tag && !r.tags.some((t) => t.toLowerCase() === tag)) return false;
    if (tagsAll.length) {
      const have = new Set(r.tags.map((t) => t.toLowerCase()));
      for (const t of tagsAll) {
        if (!have.has(t)) return false;
      }
    }
    if (q) {
      const hay =
        `${r.title} ${r.summary} ${r.user_id ?? ""} ${r.tags.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
