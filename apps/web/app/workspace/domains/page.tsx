import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import DomainsClient from "./client";

export const metadata: Metadata = {
  title: "verified domains // adherence.ml",
  description:
    "Claim email domains so new sign-ins from your company auto-join the workspace with the role you choose.",
};

export const dynamic = "force-dynamic";

export default async function WorkspaceDomainsPage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login?next=/workspace/domains");
  return <DomainsClient />;
}
