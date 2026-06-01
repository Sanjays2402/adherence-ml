import type { Metadata } from "next";
import ChangesClient from "./client";

export const metadata: Metadata = {
  title: "changes // adherence.ml",
  description:
    "Production change management register for this workspace. Risk class, four-eyes approval, planned and actual windows, rollback plan, and post implementation review for SOC 2 CC8.1.",
};

export const dynamic = "force-dynamic";

export default function ChangesPage() {
  return <ChangesClient />;
}
