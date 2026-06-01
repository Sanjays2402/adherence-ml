import { NextRequest, NextResponse } from "next/server";

import { ApiError, apiFetch } from "@/lib/api";
import { requireDashboardAuth } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read the inbound-webhook security posture surfaced by the FastAPI
 * service at /v1/webhooks/inbound/config. The posture lists each
 * partner source and whether it requires HMAC signing and/or an
 * inbound IP allowlist.
 *
 * Gated on a dashboard session because the source list reveals which
 * external systems this workspace integrates with — useful targeting
 * information for SSRF and supply-chain probes.
 */
export async function GET(req: NextRequest) {
  const auth = await requireDashboardAuth(req, {
    action: "webhooks.inbound.config.read",
  });
  if (!auth.ok) return auth.response;

  const fwd: Record<string, string> = {};
  const rid = req.headers.get("x-request-id");
  if (rid) fwd["x-request-id"] = rid;

  try {
    const data = await apiFetch(`/v1/webhooks/inbound/config`, {
      headers: fwd,
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
