/**
 * Prometheus scrape endpoint for the dashboard process.
 *
 * Exposes process and upstream-call telemetry in the standard text
 * exposition format. Mounted at `/metrics` (not `/api/...`) so the
 * matcher in `middleware.ts` can excuse it from access-log spam.
 *
 * Do not require auth on this in production. Scope it with a network
 * policy or private listener instead. Keep cardinality low: never add
 * a user_id or workspace_id label.
 */
import { NextResponse } from "next/server";
import { renderPrometheus } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const body = renderPrometheus(
    process.env.ADHERENCE_DASHBOARD_VERSION ?? "dev",
  );
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
