import type { Metadata } from "next";
import WorkspaceContactsClient from "./client";

export const metadata: Metadata = {
  title: "workspace contacts // adherence.ml",
  description:
    "Per-role notification contacts for this workspace: security, privacy, billing, abuse, technical, and breach notification.",
};

export const dynamic = "force-dynamic";

export default function WorkspaceContactsPage() {
  return <WorkspaceContactsClient />;
}
