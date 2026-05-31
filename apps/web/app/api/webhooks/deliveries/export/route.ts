import { NextRequest, NextResponse } from "next/server";
import {
  listDeliveries,
  deliveryStatus,
  type DeliveryStatusFilter,
  type WebhookDelivery,
} from "@/lib/webhooks-store";
import { requireDashboardAuth } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES: readonly DeliveryStatusFilter[] = ["all", "ok", "failed", "pending"];
const FORMATS = ["csv", "ndjson", "json"] as const;
type Format = (typeof FORMATS)[number];

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: WebhookDelivery[]): string {
  const head = [
    "id",
    "created_at_iso",
    "finished_at_iso",
    "status",
    "delivered",
    "event",
    "endpoint_id",
    "url",
    "attempts",
    "last_status_code",
    "last_error",
    "last_duration_ms",
  ];
  const out = [head.join(",")];
  for (const d of rows) {
    const last = d.attempts[d.attempts.length - 1];
    out.push(
      [
        d.id,
        new Date(d.created_at).toISOString(),
        d.finished_at ? new Date(d.finished_at).toISOString() : "",
        deliveryStatus(d),
        d.delivered ? "true" : "false",
        d.event,
        d.endpoint_id,
        csvEscape(d.url),
        d.attempts.length,
        last?.status ?? "",
        csvEscape(last?.error ?? ""),
        last?.duration_ms ?? "",
      ].join(","),
    );
  }
  return out.join("\n") + "\n";
}

function toNdjson(rows: WebhookDelivery[]): string {
  return rows.map((d) => JSON.stringify(d)).join("\n") + (rows.length ? "\n" : "");
}

function tsStamp(): string {
  // 20260531T072142Z
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

export async function GET(req: NextRequest) {
  const auth = await requireDashboardAuth(req, {
    action: "webhook.deliveries.export",
  });
  if (!auth.ok) return auth.response;
  const sp = req.nextUrl.searchParams;
  const fmtRaw = (sp.get("format") ?? "csv").toLowerCase();
  if (!FORMATS.includes(fmtRaw as Format)) {
    return NextResponse.json(
      { detail: `invalid format, expected one of ${FORMATS.join(", ")}` },
      { status: 400 },
    );
  }
  const format = fmtRaw as Format;
  const endpoint_id = sp.get("endpoint_id") ?? undefined;
  const rawStatus = sp.get("status") ?? "all";
  const status = STATUSES.includes(rawStatus as DeliveryStatusFilter)
    ? (rawStatus as DeliveryStatusFilter)
    : "all";
  const limitRaw = Number(sp.get("limit") ?? 500);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 500;

  const deliveries = await listDeliveries({ endpoint_id, status, limit });

  const stamp = tsStamp();
  const scope = endpoint_id ? `-${endpoint_id}` : "";
  const filename = `webhook-deliveries-${status}${scope}-${stamp}.${format === "json" ? "json" : format === "ndjson" ? "ndjson" : "csv"}`;

  if (format === "csv") {
    return new NextResponse(toCsv(deliveries), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (format === "ndjson") {
    return new NextResponse(toNdjson(deliveries), {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  // json
  return new NextResponse(JSON.stringify({ deliveries }, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
