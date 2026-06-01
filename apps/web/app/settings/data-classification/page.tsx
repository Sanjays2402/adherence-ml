import type { Metadata } from "next";
import DataClassificationClient from "./client";

export const metadata: Metadata = {
  title: "data classification // adherence.ml",
  description:
    "Pin this workspace to a sensitivity tier so audit, retention, and egress controls agree on how its data must be handled.",
};

export const dynamic = "force-dynamic";

export default function DataClassificationPage() {
  return <DataClassificationClient />;
}
