import type { Metadata } from "next";
import SsoEnforcementClient from "./client";

export const metadata: Metadata = {
  title: "enforce SSO // adherence.ml",
  description:
    "Require corporate SSO sign-in for this workspace and manage a small break-glass allow-list for IdP outages.",
};

export const dynamic = "force-dynamic";

export default function SsoEnforcementPage() {
  return <SsoEnforcementClient />;
}
