import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LAWFUL_BASES = [
  "consent",
  "contract",
  "legal_obligation",
  "vital_interests",
  "public_task",
  "legitimate_interests",
  "hipaa_authorization",
  "hipaa_treatment",
] as const;

const CAPTURE_CHANNELS = [
  "web_form",
  "paper_form",
  "verbal_recorded",
  "api",
  "import",
  "other",
] as const;

const GrantSchema = z.object({
  subject_ref: z.string().min(1).max(256),
  purpose: z.string().min(2).max(96),
  lawful_basis: z.enum(LAWFUL_BASES),
  capture_channel: z.enum(CAPTURE_CHANNELS),
  evidence_ref: z.string().min(1).max(512).optional().nullable(),
  notes: z.string().max(4096).optional().nullable(),
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
  const params = new URLSearchParams();
  const include = sp.get("include_withdrawn") ?? "false";
  params.set("include_withdrawn", include);
  const subj = sp.get("subject_ref");
  if (subj) params.set("subject_ref", subj);
  const purpose = sp.get("purpose");
  if (purpose) params.set("purpose", purpose);
  try {
    const data = await apiFetch(`/v1/admin/consents?${params.toString()}`);
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
  const parsed = GrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { detail: "invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const data = await apiFetch("/v1/admin/consents", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
