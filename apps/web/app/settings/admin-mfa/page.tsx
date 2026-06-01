import type { Metadata } from "next";
import AdminMfaClient from "./client";

export const metadata: Metadata = {
  title: "admin mfa // adherence.ml",
  description:
    "Backend admin TOTP MFA: enrolment health and one-click rotation of single-use backup codes. Re-authenticated with a fresh TOTP, audit logged, admin only.",
};

export const dynamic = "force-dynamic";

export default function AdminMfaPage() {
  return <AdminMfaClient />;
}
