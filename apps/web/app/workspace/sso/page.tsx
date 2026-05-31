import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import SsoClient from "./client";

export const metadata: Metadata = {
  title: "single sign-on // adherence.ml",
  description: "Configure OIDC SSO for your workspace.",
};

export const dynamic = "force-dynamic";

export default async function WorkspaceSsoPage() {
  const ctx = await getSession();
  if (!ctx) redirect("/login?next=/workspace/sso");
  return <SsoClient />;
}
