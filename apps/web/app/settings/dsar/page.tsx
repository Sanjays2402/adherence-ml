import type { Metadata } from "next";
import DSARClient from "./client";

export const metadata: Metadata = {
  title: "dsar register // adherence.ml",
  description:
    "Per-workspace register of Data Subject Access Requests with GDPR Art. 12(3) 30 day deadline tracking and SOC2 evidence.",
};

export const dynamic = "force-dynamic";

export default function DSARPage() {
  return <DSARClient />;
}
