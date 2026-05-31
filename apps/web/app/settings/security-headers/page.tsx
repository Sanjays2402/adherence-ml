import type { Metadata } from "next";
import SecurityHeadersClient from "./client";

export const metadata: Metadata = {
  title: "security headers // adherence.ml",
  description:
    "Inspect the exact HTTP security headers the dashboard sets on every response. Built for procurement reviewers and compliance audits.",
};

export const dynamic = "force-dynamic";

export default function SecurityHeadersPage() {
  return <SecurityHeadersClient />;
}
