import type { Metadata } from "next";
import SecurityClient from "./client";

export const metadata: Metadata = {
  title: "security // adherence.ml",
  description: "Two-factor authentication and recovery codes.",
};

export const dynamic = "force-dynamic";

export default function SecurityPage() {
  return <SecurityClient />;
}
