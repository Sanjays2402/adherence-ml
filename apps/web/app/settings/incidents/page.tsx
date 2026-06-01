import type { Metadata } from "next";
import IncidentsClient from "./client";

export const metadata: Metadata = {
  title: "security incidents // adherence.ml",
  description:
    "Track security incidents from discovery to resolution with GDPR Art. 33 deadline tracking and SOC2 CC7.4 evidence.",
};

export const dynamic = "force-dynamic";

export default function IncidentsPage() {
  return <IncidentsClient />;
}
