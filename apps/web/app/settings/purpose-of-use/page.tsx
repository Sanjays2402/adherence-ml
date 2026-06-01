import type { Metadata } from "next";
import PurposeOfUseClient from "./client";

export const metadata: Metadata = {
  title: "purpose of use // adherence.ml",
  description:
    "Configure the HIPAA purpose-of-use policy this workspace enforces on every PHI request, and review the PHI access log.",
};

export const dynamic = "force-dynamic";

export default function PurposeOfUsePage() {
  return <PurposeOfUseClient />;
}
