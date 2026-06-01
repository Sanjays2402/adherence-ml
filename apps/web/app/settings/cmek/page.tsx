import type { Metadata } from "next";
import CmekClient from "./client";

export const metadata: Metadata = {
  title: "customer-managed encryption // adherence.ml",
  description:
    "Declare and lifecycle-manage a customer-managed KMS key (BYOK) for this workspace.",
};

export const dynamic = "force-dynamic";

export default function CmekPage() {
  return <CmekClient />;
}
