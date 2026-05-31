import { NextResponse } from "next/server";
import { exportAllData } from "@/lib/settings-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const bundle = await exportAllData();
  const filename = `adherence-export-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
