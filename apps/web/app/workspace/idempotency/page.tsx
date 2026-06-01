import type { Metadata } from "next";
import IdempotencyClient from "./client";

export const metadata: Metadata = {
  title: "idempotency // adherence.ml",
  description:
    "Inspect the per-workspace Idempotency-Key cache used by retrying API clients.",
};

export const dynamic = "force-dynamic";

export default function IdempotencyPage() {
  return <IdempotencyClient />;
}
