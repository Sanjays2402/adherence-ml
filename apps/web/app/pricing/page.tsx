import type { Metadata } from "next";
import PricingClient from "./client";

export const metadata: Metadata = {
  title: "Pricing // adherence.ml",
  description: "Free, Pro, and Scale plans with per-day prediction quotas.",
};

export default function Page() {
  return <PricingClient />;
}
