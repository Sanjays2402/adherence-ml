import type { Metadata } from "next";
import RiskRegisterClient from "./client";

export const metadata: Metadata = {
  title: "risk register // adherence.ml",
  description:
    "Enterprise risk register for this workspace. ISO 31000 and SOC 2 CC3.2 evidence.",
};

export const dynamic = "force-dynamic";

export default function RiskRegisterPage() {
  return <RiskRegisterClient />;
}
