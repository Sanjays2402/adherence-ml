import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { previewWipe, wipeAllData } from "@/lib/settings-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Schema = z.object({
  confirm: z.literal("DELETE EVERYTHING"),
});

export async function POST(req: NextRequest) {
  // Dry-run is allowed without the confirmation phrase: that is the whole
  // point of a preview. Only the real wipe demands the typed confirmation.
  if (isDryRun(req)) {
    const preview = await previewWipe();
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "workspace_data",
          id: preview.data_dir,
          summary: `wipe ${preview.would_remove.length} managed file(s) totalling ${preview.total_bytes} bytes from ${preview.data_dir}; this is irreversible in the real call`,
          cascade: preview.would_remove.slice(0, 50).map((r) => ({
            resource: "data_file",
            id: r.file,
            label: `${r.size_bytes} bytes`,
          })),
          before: {
            data_dir: preview.data_dir,
            would_skip: preview.would_skip,
            total_bytes: preview.total_bytes,
          },
        }),
      ),
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "invalid json" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        detail:
          'destructive action requires {"confirm":"DELETE EVERYTHING"} in the request body',
      },
      { status: 400 },
    );
  }
  const report = await wipeAllData();
  return NextResponse.json({ ok: true, ...report });
}
