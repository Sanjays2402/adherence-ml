import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiFetch } from "@/lib/api";

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
  try {
    const data = await apiFetch(`/${joined}${search}`, {
      method,
      body: body && body.length > 0 ? body : undefined,
      headers: body && body.length > 0 ? { "content-type": "application/json" } : undefined,
    });
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
