import type { Metadata } from "next";
import ConsentsClient from "./client";

export const metadata: Metadata = {
  title: "consent register // adherence.ml",
  description:
    "Per-workspace data subject consent receipts for HIPAA Authorization and GDPR Article 7, with audit-logged grant and withdrawal.",
};

export const dynamic = "force-dynamic";

export default function ConsentsPage() {
  return <ConsentsClient />;
}
