import type { Metadata } from "next";
import WorkspaceClient from "./client";

export const metadata: Metadata = {
  title: "workspace // adherence.ml",
  description: "Shared workspace with member roles and email invites.",
};

export const dynamic = "force-dynamic";

export default function WorkspacePage() {
  return <WorkspaceClient />;
}
