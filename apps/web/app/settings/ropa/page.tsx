import type { Metadata } from "next";
import RopaClient from "./client";

export const metadata: Metadata = {
  title: "ropa // adherence.ml",
  description:
    "Record of Processing Activities for this workspace. Required evidence for GDPR Article 30.",
};

export const dynamic = "force-dynamic";

export default function RopaPage() {
  return <RopaClient />;
}
