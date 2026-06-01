import type { Metadata } from "next";
import SupportAccessClient from "./client";

export const metadata: Metadata = {
  title: "support access // adherence.ml",
  description:
    "Lock down vendor admin access to this workspace. Require an explicit, time-bound, audited grant before any cross-tenant request is honoured.",
};

export const dynamic = "force-dynamic";

export default function SupportAccessPage() {
  return <SupportAccessClient />;
}
