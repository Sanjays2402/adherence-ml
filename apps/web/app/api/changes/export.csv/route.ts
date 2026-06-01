import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE = process.env.ADHERENCE_API_BASE ?? "http://localhost:7421";
const KEY = process.env.ADHERENCE_API_KEY ?? "";

export async function GET(req: NextRequest) {
  const include = req.nextUrl.searchParams.get("include_archived") ?? "false";
  const headers = new Headers();
  if (KEY) headers.set("x-api-key", KEY);
  const upstream = await fetch(
    `${BASE}/v1/admin/changes/export.csv?include_archived=${encodeURIComponent(include)}`,
    { headers, cache: "no-store" },
  );
  const body = await upstream.text();
  if (!upstream.ok) {
    return new Response(body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        upstream.headers.get("content-disposition") ??
        'attachment; filename="changes.csv"',
      "cache-control": "no-store",
    },
  });
}
