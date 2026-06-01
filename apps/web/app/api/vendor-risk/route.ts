import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VENDOR_TYPES = [
  "subprocessor",
  "integration",
  "internal_tool",
  "infrastructure",
  "consultant",
  "other",
] as const;
const DATA = [
  "none",
  "metadata",
  "pii",
  "phi",
  "financial",
  "secrets",
] as const;
const RISK = ["low", "medium", "high", "critical"] as const;
const STATUSES = [
  "proposed",
  "approved",
  "conditional",
  "rejected",
] as const;

const CreateSchema = z.object({
  vendor_name: z.string().min(2).max(128),
  vendor_type: z.enum(VENDOR_TYPES),
  owner: z.string().min(1).max(128),
  data_shared: z.enum(DATA).optional(),
  inherent_risk: z.enum(RISK).optional(),
  residual_risk: z.enum(RISK).optional(),
  soc2: z.boolean().optional(),
  iso27001: z.boolean().optional(),
  hipaa: z.boolean().optional(),
  pci_dss: z.boolean().optional(),
  evidence_url: z.string().max(1024).nullish(),
  status: z.enum(STATUSES).optional(),
  notes: z.string().max(4096).nullish(),
  review_cadence_days: z.number().int().min(30).max(365 * 3).nullish(),
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
  const include = req.nextUrl.searchParams.get("include_retired") ?? "false";
  try {
    const data = await apiFetch(
      `/v1/admin/vendor-risk?include_retired=${encodeURIComponent(include)}`,
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
    const data = await apiFetch("/v1/admin/vendor-risk", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
