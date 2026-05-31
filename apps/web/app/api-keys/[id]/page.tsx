import type { Metadata } from "next";
import KeyDetailClient from "./client";

export const metadata: Metadata = {
  title: "key usage // adherence.ml",
  description: "Recent requests, 14-day call volume, and endpoint breakdown for an API key.",
};

export const dynamic = "force-dynamic";

export default async function KeyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <KeyDetailClient id={id} />;
}
