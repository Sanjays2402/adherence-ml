import { NextRequest, NextResponse } from "next/server";
import { tagCounts, type RunKind } from "@/lib/runs-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = ["predict", "demo", "explain", "cohort", "forecast", "other", "all"] as const;

/**
 * GET /api/runs/tags?kind=predict
 * Returns the set of tags present across saved runs with their counts,
 * sorted by count desc. Drives the tag filter chips on /history.
 */
export async function GET(req: NextRequest) {
  const kindRaw = req.nextUrl.searchParams.get("kind");
  const kind =
    kindRaw && (KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as RunKind | "all")
      : "all";
  const tags = await tagCounts(kind);
  return NextResponse.json(
    { tags, total: tags.reduce((n, t) => n + t.count, 0) },
    {
      headers: {
        // Short cache; history page polls every 15s so this is fine.
        "cache-control": "private, max-age=5",
      },
    },
  );
}
