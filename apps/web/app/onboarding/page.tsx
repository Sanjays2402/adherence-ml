import type { Metadata } from "next";
import OnboardingClient from "./client";

export const metadata: Metadata = {
  title: "onboarding // adherence.ml",
  description: "Three steps to a working workspace: seed data, issue a key, save a run.",
};

export const dynamic = "force-dynamic";

export default function OnboardingPage() {
  return <OnboardingClient />;
}
