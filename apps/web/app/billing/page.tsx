import { Suspense } from "react";
import type { Metadata } from "next";
import BillingClient from "./client";

export const metadata: Metadata = {
  title: "Billing // adherence.ml",
  description: "Current plan, quota usage, and plan change history.",
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <BillingClient />
    </Suspense>
  );
}
