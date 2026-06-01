import type { Metadata } from "next";
import SsoGroupRolesClient from "./client";

export const metadata: Metadata = {
  title: "sso group roles // adherence.ml",
  description:
    "Map identity provider groups to internal roles for this workspace so Okta, Azure AD, or Google Workspace can provision access by group membership.",
};

export const dynamic = "force-dynamic";

export default function SsoGroupRolesPage() {
  return <SsoGroupRolesClient />;
}
