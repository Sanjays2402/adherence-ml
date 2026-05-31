import type { Metadata } from "next";
import VerifyClient from "./client";

export const metadata: Metadata = {
  title: "verifying // adherence.ml",
};

export const dynamic = "force-dynamic";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const sp = await searchParams;
  return <VerifyClient token={sp.token ?? null} next={sp.next ?? null} />;
}
