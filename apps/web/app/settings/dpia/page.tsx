import type { Metadata } from "next";
import DpiaClient from "./client";

export const metadata: Metadata = {
  title: "dpia // adherence.ml",
  description:
    "Data Protection Impact Assessment register for this workspace. Required evidence for GDPR Article 35.",
};

export const dynamic = "force-dynamic";

export default function DpiaPage() {
  return <DpiaClient />;
}
