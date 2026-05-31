import { NextResponse } from "next/server";
import { summary } from "@/lib/usage-store";
import { listKeys } from "@/lib/api-keys-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [s, keys] = await Promise.all([summary(), listKeys()]);
  const nameById = new Map(keys.map((k) => [k.id, k.name] as const));
  const prefixById = new Map(keys.map((k) => [k.id, k.prefix] as const));
  return NextResponse.json({
    ...s,
    by_key_30d: s.by_key_30d.map((r) => ({
      ...r,
      name: nameById.get(r.key_id) ?? "(revoked or unknown)",
      prefix: prefixById.get(r.key_id) ?? "",
    })),
  });
}
