import type { Metadata } from "next";
import ModelApprovalClient from "./client";

export const metadata: Metadata = {
  title: "model approval // adherence.ml",
  description:
    "Govern which model versions may score this workspace. Optional enforce mode rejects unapproved versions at the API.",
};

export const dynamic = "force-dynamic";

export default function ModelApprovalPage() {
  return <ModelApprovalClient />;
}
