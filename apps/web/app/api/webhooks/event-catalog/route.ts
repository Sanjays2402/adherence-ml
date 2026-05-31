import { NextResponse } from "next/server";

import { CATALOG_EVENTS, catalogSummary } from "@/lib/webhook-catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The webhook event catalog is part of the product surface so it is
// readable without a session. Procurement reviewers fetch this during
// vendor evaluation; gating behind auth would defeat the purpose.
export function GET() {
  return NextResponse.json({
    ...catalogSummary(),
    events: CATALOG_EVENTS,
  });
}
