import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiFetch } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KINDS = [
  "ci",
  "etl",
  "integration",
  "webhook",
  "monitor",
  "daemon",
  "backup",
  "other",
] as const;

const CREDENTIAL_KINDS = [
  "api_key",
  "oauth_client",
  "oidc_sa",
  "ssh_key",
  "certificate",
  "shared_secret",
] as const;

const STATUSES = ["active", "suspended", "decommissioned"] as const;

const CreateSchema = z.object({
  name: z.string().min(2).max(96),
  kind: z.enum(KINDS),
  system_of_record: z.string().min(2).max(96),
  credential_kind: z.enum(CREDENTIAL_KINDS),
  owner_email: z.string().email().max(254),
  scopes: z.array(z.string().min(1).max(96)).max(32).optional(),
  vault_managed: z.boolean().default(false),
  rotation_cadence_days: z.number().int().min(7).max(365 * 2).nullish(),
  review_cadence_days: z.number().int().min(30).max(365 * 2).nullish(),
  last_rotated_at: z.string().min(1).nullish(),
  last_reviewed_at: z.string().min(1).nullish(),
  last_used_at: z.string().min(1).nullish(),
  status: z.enum(STATUSES).default("active"),
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
  const include = req.nextUrl.searchParams.get("include_archived") ?? "false";
  const statusFilter = req.nextUrl.searchParams.get("status");
  const qs = new URLSearchParams({ include_archived: include });
  if (statusFilter) qs.set("status", statusFilter);
  try {
    const data = await apiFetch(`/v1/admin/service-accounts?${qs.toString()}`);
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
    const data = await apiFetch("/v1/admin/service-accounts", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      headers: { "content-type": "application/json" },
    });
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return bubble(err);
  }
}
