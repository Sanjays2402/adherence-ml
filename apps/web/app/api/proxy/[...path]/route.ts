import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";
import { appendRun, newRunId, type RunKind } from "@/lib/runs-store";

function inferKind(path: string): RunKind | null {
  if (path === "v1/predict") return "predict";
  if (path === "v1/cohort/risk") return "cohort";
  if (path === "v1/forecast/user") return "forecast";
  return null;
}

function summarise(kind: RunKind, reqBody: unknown, res: unknown): { title: string; summary: string; user_id: string | null } {
  const r = (reqBody ?? {}) as Record<string, unknown>;
  const s = (res ?? {}) as Record<string, unknown>;
  const user_id = typeof r.user_id === "string" ? r.user_id : null;
  if (kind === "predict") {
    const risk = typeof s.risk === "number" ? (s.risk as number) : null;
    const band = typeof s.band === "string" ? s.band : (typeof s.risk_band === "string" ? s.risk_band : "");
    return {
      title: user_id ? `predict ${user_id}` : "predict",
      summary: risk !== null ? `risk ${(risk * 100).toFixed(1)}% ${band}`.trim() : (band || "score"),
      user_id,
    };
  }
  if (kind === "cohort") {
    const n = Array.isArray((s as { items?: unknown[] }).items) ? (s as { items: unknown[] }).items.length : null;
    return { title: "cohort risk", summary: n !== null ? `${n} users scored` : "cohort scored", user_id: null };
  }
  if (kind === "forecast") {
    return { title: user_id ? `forecast ${user_id}` : "forecast", summary: "7-day projection", user_id };
  }
  return { title: kind, summary: "", user_id };
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Allow-list of upstream paths the browser may call through this proxy.
// Keep this tight: we never want the browser to invoke admin endpoints
// it has no reason to use.
const ALLOW: { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /^v1\/predict$/ },
  { method: "POST", pattern: /^v1\/interventions$/ },
  { method: "POST", pattern: /^v1\/interventions\/\d+\/ack$/ },
  { method: "POST", pattern: /^v1\/cohort\/risk$/ },
  { method: "POST", pattern: /^v1\/forecast\/user$/ },
];

function isAllowed(method: string, path: string) {
  return ALLOW.some((r) => r.method === method && r.pattern.test(path));
}

async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const joined = (path ?? []).join("/");
  const method = req.method.toUpperCase();
  if (!isAllowed(method, joined)) {
    return NextResponse.json({ detail: "path not allowed" }, { status: 403 });
  }
  const search = req.nextUrl.search ?? "";
  const body = method === "GET" ? undefined : await req.text();
  const t0 = Date.now();
  try {
    const data = await apiFetch(`/${joined}${search}`, {
      method,
      body: body && body.length > 0 ? body : undefined,
      headers: body && body.length > 0 ? { "content-type": "application/json" } : undefined,
    });
    const kind = inferKind(joined);
    if (kind && method === "POST") {
      try {
        const parsedReq = body ? JSON.parse(body) : null;
        const { title, summary, user_id } = summarise(kind, parsedReq, data);
        await appendRun({
          id: newRunId(),
          created_at: Date.now(),
          kind,
          title,
          summary,
          user_id,
          latency_ms: Date.now() - t0,
          payload: { request: parsedReq, response: data },
          tags: [],
        });
      } catch {
        // never let history persistence break the user-facing call
      }
    }
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        typeof err.body === "object" && err.body !== null
          ? err.body
          : { detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { detail: err instanceof Error ? err.message : "upstream error" },
      { status: 502 },
    );
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
