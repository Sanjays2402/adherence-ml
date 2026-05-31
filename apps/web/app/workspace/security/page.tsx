import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import SecurityClient from "./client";

export const metadata: Metadata = {
  title: "security policy // adherence.ml",
  description: "Session lifetime and MFA enforcement for your workspace.",
};

export const dynamic = "force-dynamic";

export default async function WorkspaceSecurityPage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login?next=/workspace/security");
  return <SecurityClient />;
}
