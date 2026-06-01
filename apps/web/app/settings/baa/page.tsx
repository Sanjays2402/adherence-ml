import type { Metadata } from "next";
import BaaClient from "./client";

export const metadata: Metadata = {
  title: "baa // adherence.ml",
  description:
    "Per-workspace HIPAA Business Associate Agreement register. Required evidence before PHI access in U.S. health, payer, and pharmacy deployments.",
};

export const dynamic = "force-dynamic";

export default function BaaPage() {
  return <BaaClient />;
}
