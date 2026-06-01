import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE = process.env.ADHERENCE_API_BASE ?? "http://localhost:7421";
const KEY = process.env.ADHERENCE_API_KEY ?? "";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const qs = new URLSearchParams();
  const limit = url.searchParams.get("limit");
  const tenant = url.searchParams.get("tenant");
  if (limit) qs.set("limit", limit);
  if (tenant) qs.set("tenant", tenant);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const upstream = `${BASE}/v1/admin/break-glass/export.csv${suffix}`;
  const h: Record<string, string> = {};
  if (KEY) h["x-api-key"] = KEY;
  const rid = req.headers.get("x-request-id");
  if (rid) h["x-request-id"] = rid;
  let res: Response;
  try {
    res = await fetch(upstream, { headers: h, cache: "no-store" });
  } catch (err) {
    return NextResponse.json(
      { detail: err instanceof Error ? err.message : "upstream error" },
      { status: 502 },
    );
  }
  if (!res.ok) {
    const text = await res.text();
    return new NextResponse(text || `upstream ${res.status}`, {
      status: res.status,
    });
  }
  const body = await res.arrayBuffer();
  const filename = (tenant ?? "tenant").replace(/[^a-z0-9._-]/gi, "_");
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type":
        res.headers.get("content-type") ?? "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="break-glass-${filename}.csv"`,
    },
  });
}
