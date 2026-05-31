import type { Metadata } from "next";
import TrustClient from "./client";

export const metadata: Metadata = {
  title: "trust // adherence.ml",
  description:
    "Security posture, controls, subprocessors, and vulnerability disclosure policy for adherence.ml.",
  robots: { index: true, follow: true },
};

export const dynamic = "force-dynamic";

export default function TrustPage() {
  return <TrustClient />;
}
