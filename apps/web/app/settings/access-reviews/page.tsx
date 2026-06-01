import type { Metadata } from "next";
import AccessReviewsClient from "./client";

export const metadata: Metadata = {
  title: "access reviews // adherence.ml",
  description:
    "Periodic SOC2 CC6.3 access reviews. Snapshot every workspace member, decide keep, change, or revoke, then apply.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function AccessReviewsPage() {
  return <AccessReviewsClient />;
}
