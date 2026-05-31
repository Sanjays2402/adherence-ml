import type { Metadata } from "next";
import VerifyTwoFactorClient from "./client";

export const metadata: Metadata = {
  title: "two-factor // adherence.ml",
  description: "Confirm your authenticator code to finish signing in.",
};

export const dynamic = "force-dynamic";

export default async function VerifyTwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  return <VerifyTwoFactorClient next={sp.next ?? null} />;
}
