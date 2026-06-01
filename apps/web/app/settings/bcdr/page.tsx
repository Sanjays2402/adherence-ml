import type { Metadata } from "next";
import BcdrClient from "./client";

export const metadata: Metadata = {
  title: "bcdr // adherence.ml",
  description:
    "Business continuity and disaster recovery declarations for this workspace. RTO, RPO, DR strategy, runbook, and DR test history per service.",
};

export const dynamic = "force-dynamic";

export default function BcdrPage() {
  return <BcdrClient />;
}
