import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PURPOSES = [
  "public_health",
  "victim_of_abuse",
  "health_oversight",
  "judicial",
  "law_enforcement",
  "decedent",
  "organ_donation",
  "research",
  "serious_threat",
  "workers_comp",
  "business_associate",
  "other",
] as const;

const RecordSchema = z.object({
  subject_id: z.string().min(1).max(128),
  recipient_name: z.string().min(2).max(256),
  recipient_org: z.string().max(256).nullish(),
  purpose: z.enum(PURPOSES),
  phi_description: z.string().min(2).max(4096),
  legal_basis: z.string().max(256).nullish(),
  requested_by: z.string().min(2).max(128),
  disclosed_at: z.string().datetime({ offset: true }).nullish(),
  notes: z.string().max(4096).nullish(),
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
  const sp = req.nextUrl.searchParams;
  const qs = new URLSearchParams();
  for (const k of ["subject_id", "purpose", "since", "until", "limit"]) {
    const v = sp.get(k);
    if (v) qs.set(k, v);
  }
  const q = qs.toString();
  try {
    const data = await apiFetch(
      `/v1/admin/disclosures${q ? `?${q}` : ""}`,
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
  const parsed = RecordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch("/v1/admin/disclosures", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
