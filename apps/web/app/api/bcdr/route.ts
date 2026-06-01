import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TIERS = ["tier1", "tier2", "tier3"] as const;
const STRATEGIES = [
  "backup_restore",
  "pilot_light",
  "warm_standby",
  "multi_site",
] as const;

const MAX_RTO = 60 * 24 * 365;
const MAX_RPO = 60 * 24 * 365;

const CreateSchema = z.object({
  service_name: z.string().min(2).max(128),
  tier: z.enum(TIERS),
  rto_minutes: z.number().int().min(0).max(MAX_RTO),
  rpo_minutes: z.number().int().min(0).max(MAX_RPO),
  strategy: z.enum(STRATEGIES),
  runbook_url: z.string().max(512).nullish(),
  notes: z.string().max(4096).nullish(),
  test_cadence_days: z.number().int().min(30).max(365 * 2).nullish(),
});

function bubble(err: unknown): NextResponse {
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

export async function GET(req: NextRequest) {
  const include = req.nextUrl.searchParams.get("include_archived") ?? "false";
  try {
    const data = await apiFetch(
      `/v1/admin/bcdr?include_archived=${encodeURIComponent(include)}`,
    );
    return NextResponse.json(data);
  } catch (err) {
    return bubble(err);
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch("/v1/admin/bcdr", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
