import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import QuotaClient from "./client";

export const metadata: Metadata = {
  title: "quota and plans // adherence.ml",
  description: "Per-workspace prediction quotas, plan tiers, and current usage.",
};

export const dynamic = "force-dynamic";

export default async function WorkspaceQuotaPage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login?next=/workspace/quota");
  return <QuotaClient />;
}
