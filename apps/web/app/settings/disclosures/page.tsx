import type { Metadata } from "next";
import DisclosuresClient from "./client";

export const metadata: Metadata = {
  title: "disclosures // adherence.ml",
  description:
    "HIPAA Accounting of Disclosures register for this workspace. Record PHI disclosures to external recipients, query a per-patient accounting under 45 CFR 164.528, and export the register for audit.",
};

export const dynamic = "force-dynamic";

export default function DisclosuresPage() {
  return <DisclosuresClient />;
}
