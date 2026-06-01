import type { Metadata } from "next";
import RetentionPolicyClient from "./client";

export const metadata: Metadata = {
  title: "retention policy // adherence.ml",
  description:
    "Per-workspace data retention TTLs and tenant-scoped sweep. Tighter than the deployment default, dry-run aware, audit logged, MFA gated.",
};

export const dynamic = "force-dynamic";

export default function RetentionPolicyPage() {
  return <RetentionPolicyClient />;
}
