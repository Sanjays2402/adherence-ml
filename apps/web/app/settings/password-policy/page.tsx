import type { Metadata } from "next";
import PasswordPolicyClient from "./client";

export const metadata: Metadata = {
  title: "password policy // adherence.ml",
  description:
    "Tune the per-workspace password rules used by local credentials, SCIM-provisioned service accounts, and break-glass logins.",
};

export const dynamic = "force-dynamic";

export default function PasswordPolicyPage() {
  return <PasswordPolicyClient />;
}
