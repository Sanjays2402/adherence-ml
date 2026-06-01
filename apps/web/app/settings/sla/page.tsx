import type { Metadata } from "next";
import SlaClient from "./client";

export const metadata: Metadata = {
  title: "sla // adherence.ml",
  description:
    "Per-workspace SLA commitment register. Contracted uptime, severity response targets, RTO and RPO. Procurement evidence for SOC 2 CC3.4 and CAIQ STA-05.",
};

export const dynamic = "force-dynamic";

export default function SlaPage() {
  return <SlaClient />;
}
