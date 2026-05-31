import type { Metadata } from "next";
import AuthEventsClient from "./client";

export const metadata: Metadata = {
  title: "auth events // adherence.ml",
  description:
    "Sign-in, sign-out, MFA, SSO, and OAuth events with actor, IP, method, outcome, and failure reason. Append-only hash chain. CSV export for SIEM.",
};

export const dynamic = "force-dynamic";

export default function AuthEventsPage() {
  return <AuthEventsClient />;
}
