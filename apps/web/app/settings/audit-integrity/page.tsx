import type { Metadata } from "next";
import AuditIntegrityClient from "./client";

export const metadata: Metadata = {
  title: "audit integrity // adherence.ml",
  description:
    "Verify the tamper-evident hash chain on the admin audit log. SOC2 CC7.2 / ISO 27001 A.12.4.2 evidence on demand.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function AuditIntegrityPage() {
  return <AuditIntegrityClient />;
}
