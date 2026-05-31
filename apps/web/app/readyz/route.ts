/**
 * Readiness probe for the dashboard.
 *
 * Returns 503 when the upstream FastAPI service is not reachable so the
 * load balancer removes this pod from rotation. Use this for
 * Kubernetes `readinessProbe`. Time-bounded so a slow upstream cannot
 * stall the probe.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = process.env.ADHERENCE_API_BASE ?? "http://localhost:7421";
const TIMEOUT_MS = 1500;

async function checkUpstream(): Promise<{ ok: boolean; status: number | null; latency_ms: number; error?: string }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${UPSTREAM}/livez`, { signal: ctrl.signal, cache: "no-store" });
    return { ok: res.ok, status: res.status, latency_ms: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const upstream = await checkUpstream();
  const ready = upstream.ok;
  const body = {
    ready,
    service: "adherence-dashboard",
    version: process.env.ADHERENCE_DASHBOARD_VERSION ?? "dev",
    checks: { upstream_api: upstream },
    ts: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: ready ? 200 : 503 });
}
