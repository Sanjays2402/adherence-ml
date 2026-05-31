import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ScimClient from "./client";

export const metadata: Metadata = {
  title: "SCIM provisioning // adherence.ml",
  description:
    "Manage workspace-scoped SCIM 2.0 bearer tokens for identity-provider user provisioning.",
};

export const dynamic = "force-dynamic";

export default async function ScimPage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login?next=/workspace/scim");
  return <ScimClient />;
}
