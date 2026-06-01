import type { Metadata } from "next";
import InvitePolicyClient from "./client";

export const metadata: Metadata = {
  title: "invite policy // adherence.ml",
  description:
    "Restrict workspace invitations to approved email domains and block known personal mail providers.",
};

export const dynamic = "force-dynamic";

export default function InvitePolicyPage() {
  return <InvitePolicyClient />;
}
