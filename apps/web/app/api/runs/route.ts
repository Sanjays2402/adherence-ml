import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  appendRun,
  listRuns,
  newRunId,
  type RunKind,
  type RunRecord,
} from "@/lib/runs-store";
import { emit } from "@/lib/webhook-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = ["predict", "demo", "explain", "cohort", "forecast", "other"] as const;

const PostSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().min(1).max(200),
  summary: z.string().max(500).default(""),
  user_id: z.string().max(120).nullable().optional(),
  latency_ms: z.number().int().nonnegative().nullable().optional(),
  payload: z.unknown(),
  tags: z.array(z.string().max(40)).max(12).default([]),
});

export async function POST(req: NextRequest) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = PostSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const rec: RunRecord = {
    id: newRunId(),
    created_at: Date.now(),
    kind: parsed.data.kind,
    title: parsed.data.title,
    summary: parsed.data.summary ?? "",
    user_id: parsed.data.user_id ?? null,
    latency_ms: parsed.data.latency_ms ?? null,
    payload: parsed.data.payload,
    tags: parsed.data.tags ?? [],
  };
  await appendRun(rec);
  // fire-and-forget webhook fanout; never blocks the response
  void emit("run.created", {
    id: rec.id,
    kind: rec.kind,
    title: rec.title,
    summary: rec.summary,
    user_id: rec.user_id,
    latency_ms: rec.latency_ms,
    tags: rec.tags,
    created_at: rec.created_at,
    url: `/history/${rec.id}`,
  });
  return NextResponse.json({ id: rec.id, created_at: rec.created_at }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kindRaw = sp.get("kind");
  const kind =
    kindRaw && (KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as RunKind)
      : "all";
  const limit = Number(sp.get("limit") ?? 25);
  const offset = Number(sp.get("offset") ?? 0);
  const q = sp.get("q") ?? undefined;
  const result = await listRuns({
    q,
    kind: kind as RunKind | "all",
    limit: Number.isFinite(limit) ? limit : 25,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return NextResponse.json(result);
}
