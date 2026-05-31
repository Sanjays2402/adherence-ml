import type { Metadata } from "next";
import LoginThrottleClient from "./client";

export const metadata: Metadata = {
  title: "login throttle // adherence.ml",
  description:
    "Review and clear active sign-in lockouts protecting magic-link and TOTP endpoints from brute force.",
};

export const dynamic = "force-dynamic";

export default function LoginThrottlePage() {
  return <LoginThrottleClient />;
}
