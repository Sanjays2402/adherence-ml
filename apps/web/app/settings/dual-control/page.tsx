import type { Metadata } from "next";
import DualControlClient from "./client";

export const metadata: Metadata = {
  title: "dual control // adherence.ml",
  description:
    "Require a second admin to approve sensitive actions. Open requests, approve or reject pending ones, and gate specific action types per workspace.",
};

export const dynamic = "force-dynamic";

export default function DualControlPage() {
  return <DualControlClient />;
}
