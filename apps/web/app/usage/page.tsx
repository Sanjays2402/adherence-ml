import type { Metadata } from "next";
import UsageClient from "./client";

export const metadata: Metadata = {
  title: "usage // adherence.ml",
  description: "Daily quota meter, 30-day sparkline, per-key breakdown, and upgrade CTA.",
};

export const dynamic = "force-dynamic";

export default function UsagePage() {
  return <UsageClient />;
}
