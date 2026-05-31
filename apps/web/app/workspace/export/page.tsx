import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ExportClient from "./client";

export const metadata: Metadata = {
  title: "data export // adherence.ml",
  description:
    "Workspace-wide GDPR and CCPA data export. Owners can download every member, invite, audit entry, run, and note as JSON or CSV.",
};

export const dynamic = "force-dynamic";

export default async function WorkspaceExportPage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login?next=/workspace/export");
  return <ExportClient />;
}
