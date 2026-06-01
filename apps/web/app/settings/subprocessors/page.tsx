import type { Metadata } from "next";
import SubprocessorsClient from "./client";

export const metadata: Metadata = {
  title: "sub-processors // adherence.ml",
  description:
    "Third-party processors used to deliver the service, the change log, and per-workspace acknowledgments required by GDPR Art. 28.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function SubprocessorsPage() {
  return <SubprocessorsClient />;
}
