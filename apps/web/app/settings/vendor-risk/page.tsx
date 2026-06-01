import type { Metadata } from "next";
import VendorRiskClient from "./client";

export const metadata: Metadata = {
  title: "vendor risk // adherence.ml",
  description:
    "Per-workspace vendor risk assessment register. Track sub-processors, integrations, and internal tools with inherent and residual risk, attested certifications, owner, status, and review cadence.",
};

export const dynamic = "force-dynamic";

export default function VendorRiskPage() {
  return <VendorRiskClient />;
}
