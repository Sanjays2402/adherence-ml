import { NextRequest, NextResponse } from "next/server";
import { listKeys, revokeKey, publicView } from "@/lib/api-keys-store";
import { dryRunBody, isDryRun, withDryRunHeaders } from "@/lib/dry-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  // Peek without mutating so we can render dry-run previews AND return a
  // helpful 404 in the live path before touching the write queue.
  const keys = await listKeys();
  const target = keys.find((k) => k.id === id);
  if (!target) return NextResponse.json({ detail: "not found" }, { status: 404 });

  if (isDryRun(req)) {
    if (target.revoked) {
      return withDryRunHeaders(
        NextResponse.json(
          dryRunBody({
            resource: "api_key",
            id,
            summary: "already revoked, no change would be made",
            before: publicView(target) as unknown as Record<string, unknown>,
          }),
        ),
      );
    }
    return withDryRunHeaders(
      NextResponse.json(
        dryRunBody({
          resource: "api_key",
          id,
          summary: `revoke API key '${target.name}' (prefix ${target.prefix}); future requests with this key will fail with 401`,
          before: publicView(target) as unknown as Record<string, unknown>,
        }),
      ),
    );
  }

  const ok = await revokeKey(id);
  if (!ok) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
