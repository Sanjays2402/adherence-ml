import type { Metadata } from "next";
import ModelCardsClient from "./client";

export const metadata: Metadata = {
  title: "ai model cards // adherence.ml",
  description:
    "Per-workspace AI Transparency Register. Model name, version, owner, training data sensitivity, PHI suitability, fairness status, and last validation date. Procurement evidence for EU AI Act Article 13, NIST AI RMF, and ISO/IEC 42001.",
};

export const dynamic = "force-dynamic";

export default function ModelCardsPage() {
  return <ModelCardsClient />;
}
