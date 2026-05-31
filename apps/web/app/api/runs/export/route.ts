import { NextRequest, NextResponse } from "next/server";
import { listAllRuns, type RunRecord, type RunKind } from "@/lib/runs-store";
import { filterRunsForExport, parseExportDate, type ExportFilters } from "@/lib/runs-export";

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
    from: parseExportDate(sp.get("from"), false),
    to: parseExportDate(sp.get("to"), true),
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
