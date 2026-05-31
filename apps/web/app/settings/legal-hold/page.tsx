import type { Metadata } from "next";
import LegalHoldClient from "./client";

export const metadata: Metadata = {
  title: "legal hold // adherence.ml",
  description:
    "Place a litigation or preservation hold on this workspace. While active, GDPR erasure and retention sweeps are blocked.",
};

export const dynamic = "force-dynamic";

export default function LegalHoldPage() {
  return <LegalHoldClient />;
}
