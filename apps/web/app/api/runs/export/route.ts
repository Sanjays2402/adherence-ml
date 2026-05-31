import { NextRequest, NextResponse } from "next/server";
import { listAllRuns, type RunRecord } from "@/lib/runs-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(req: NextRequest) {
  const fmt = (req.nextUrl.searchParams.get("format") ?? "json").toLowerCase();
  const all = (await listAllRuns()).sort((a, b) => b.created_at - a.created_at);
  if (fmt === "csv") {
    return new NextResponse(toCsv(all), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="adherence-runs-${Date.now()}.csv"`,
      },
    });
  }
  return new NextResponse(JSON.stringify(all, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="adherence-runs-${Date.now()}.json"`,
    },
  });
}
