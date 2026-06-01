import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import DangerZoneClient from "./client";

export const metadata: Metadata = {
  title: "danger zone // adherence.ml",
  description:
    "Owner-only tenant offboarding: permanently delete a workspace and every workspace-scoped record.",
};

export const dynamic = "force-dynamic";

export default async function WorkspaceDangerZonePage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login?next=/workspace/danger-zone");
  return <DangerZoneClient workspaceId={null} />;
}
