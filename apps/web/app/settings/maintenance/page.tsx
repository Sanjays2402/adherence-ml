import type { Metadata } from "next";
import MaintenanceClient from "./client";

export const metadata: Metadata = {
  title: "maintenance windows // adherence.ml",
  description:
    "Per-workspace scheduled maintenance window register with audit-logged mutations, CSV export, and an in-flight status feed.",
};

export const dynamic = "force-dynamic";

export default function MaintenancePage() {
  return <MaintenanceClient />;
}
