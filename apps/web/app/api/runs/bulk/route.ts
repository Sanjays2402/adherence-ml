import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteRuns, setRunsPinned } from "@/lib/runs-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BulkSchema = z.object({
  action: z.enum(["delete", "pin", "unpin"]),
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
});

export async function POST(req: NextRequest) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "request body was not valid JSON" },
      { status: 400 },
    );
  }
  const parsed = BulkSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_failed", detail: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const { action, ids } = parsed.data;
  // De-dupe before touching the store; cheap and avoids redundant work.
  const unique = Array.from(new Set(ids));
  try {
    if (action === "delete") {
      const removed = await deleteRuns(unique);
      return NextResponse.json({ action, requested: unique.length, affected: removed });
    }
    const changed = await setRunsPinned(unique, action === "pin");
    return NextResponse.json({ action, requested: unique.length, affected: changed });
  } catch (err) {
    return NextResponse.json(
      {
        error: "bulk_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
