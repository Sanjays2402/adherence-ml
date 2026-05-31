import { NextRequest, NextResponse } from "next/server";
import { listAllRuns, type RunRecord, type RunKind } from "@/lib/runs-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = ["predict", "demo", "explain", "cohort", "forecast", "other"] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: RunRecord[]): string {
  const head = [
    "id",
    "created_at_iso",
    "kind",
    "title",
    "summary",
    "user_id",
    "latency_ms",
    "tags",
  ];
  const out = [head.join(",")];
  for (const r of rows) {
    out.push(
      [
        r.id,
        new Date(r.created_at).toISOString(),
        r.kind,
        csvEscape(r.title),
        csvEscape(r.summary),
        csvEscape(r.user_id ?? ""),
        r.latency_ms ?? "",
        csvEscape(r.tags.join("|")),
      ].join(","),
    );
  }
  return out.join("\n") + "\n";
}

function toNdjson(rows: RunRecord[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** Parse a date in YYYY-MM-DD or ISO form; returns epoch ms or null. */
function parseDate(raw: string | null, endOfDay: boolean): number | null {
  if (!raw) return null;
  // Accept bare YYYY-MM-DD as a local-day boundary in UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const t = Date.parse(raw + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"));
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

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

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const fmt = (sp.get("format") ?? "json").toLowerCase();
  const kindRaw = sp.get("kind");
  const kind =
    kindRaw && (KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as RunKind)
      : "all";

  const filters: ExportFilters = {
    q: sp.get("q") ?? undefined,
    kind,
    tag: sp.get("tag") ?? undefined,
    user_id: sp.get("user_id") ?? undefined,
    from: parseDate(sp.get("from"), false),
    to: parseDate(sp.get("to"), true),
  };

  const all = await listAllRuns();
  const filtered = filterRunsForExport(all, filters).sort(
    (a, b) => b.created_at - a.created_at,
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix =
    [
      filters.kind && filters.kind !== "all" ? filters.kind : null,
      filters.tag ? `tag-${filters.tag}` : null,
      filters.q ? "filtered" : null,
    ]
      .filter(Boolean)
      .join("-") || "all";

  if (fmt === "csv") {
    return new NextResponse(toCsv(filtered), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="adherence-runs-${suffix}-${stamp}.csv"`,
        "x-export-count": String(filtered.length),
      },
    });
  }
  if (fmt === "ndjson" || fmt === "jsonl") {
    return new NextResponse(toNdjson(filtered), {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="adherence-runs-${suffix}-${stamp}.ndjson"`,
        "x-export-count": String(filtered.length),
      },
    });
  }
  return new NextResponse(JSON.stringify(filtered, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="adherence-runs-${suffix}-${stamp}.json"`,
      "x-export-count": String(filtered.length),
    },
  });
}
