/**
 * Saved searches collection endpoint.
 *
 *   GET  /api/saved-searches            -> { items }
 *   POST /api/saved-searches            -> create
 *
 * Saved searches are scoped per user. Anonymous visitors share a single
 * "_anon" bucket so the feature still works in dev / before sign-in; once
 * a user logs in their personal saved searches are isolated by user id.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import {
  createSavedSearch,
  listSavedSearches,
  normalizeFilters,
} from "@/lib/saved-searches-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANON = "_anon";

const FiltersSchema = z.object({
  q: z.string().max(200).default(""),
  kind: z
    .enum(["all", "predict", "demo", "explain", "cohort", "forecast", "other"])
    .default("all"),
  from: z.string().max(20).default(""),
  to: z.string().max(20).default(""),
  tags: z.array(z.string().max(40)).max(12).default([]),
  pinned_only: z.boolean().default(false),
});

const PostSchema = z.object({
  name: z.string().min(1).max(80),
  filters: FiltersSchema,
});

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  const uid = session?.user.id ?? ANON;
  const items = await listSavedSearches(uid);
  return NextResponse.json({
    items,
    authenticated: !!session,
  });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const session = await getSession(req);
  const uid = session?.user.id ?? ANON;
  const rec = await createSavedSearch({
    user_id: uid,
    name: parsed.data.name,
    filters: normalizeFilters(parsed.data.filters),
  });
  return NextResponse.json(rec, { status: 201 });
}
