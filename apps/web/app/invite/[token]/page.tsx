import type { Metadata } from "next";
import InviteAcceptClient from "./client";

export const metadata: Metadata = {
  title: "Join workspace // adherence.ml",
  description: "Accept an invitation to join a shared adherence.ml workspace.",
};

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <InviteAcceptClient token={token} />;
}
