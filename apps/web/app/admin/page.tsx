import type { Metadata } from "next";
import AdminClient from "./client";

export const metadata: Metadata = {
  title: "admin // adherence.ml",
  description:
    "Owner-only console: members, sessions, API keys, audit log, and usage in one view.",
};

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <AdminClient />;
}
