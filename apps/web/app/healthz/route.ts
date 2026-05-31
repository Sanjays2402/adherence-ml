/**
 * Liveness + light health probe for the dashboard process.
 *
 * Returns 200 with process metadata. Does NOT touch the upstream API or
 * disk; use `/readyz` for that. This endpoint is what your load balancer
 * should hit a few times a second.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "adherence-dashboard",
    version: process.env.ADHERENCE_DASHBOARD_VERSION ?? "dev",
    node: process.version,
    uptime_seconds: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
}
