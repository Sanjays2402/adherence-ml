import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getShare } from "@/lib/shares";
import { fmtPct } from "@/lib/utils";

import ShareView from "./share-view";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const record = await getShare(id);
  if (!record) {
    return {
      title: "Shared result not found // adherence.ml",
    };
  }
  const preds = record.result.predictions;
  const avgMiss =
    preds.length === 0
      ? 0
      : preds.reduce((s, p) => s + p.miss_probability, 0) / preds.length;
  const high = preds.filter((p) => p.risk_tier === "high").length;
  const desc =
    `${preds.length} dose${preds.length === 1 ? "" : "s"} for ${record.user_id}. ` +
    `Avg miss ${fmtPct(avgMiss)}, ${high} high-risk. Model ${record.result.model_version}.`;
  return {
    title: `Shared prediction for ${record.user_id} // adherence.ml`,
    description: desc,
    openGraph: {
      title: `Adherence prediction // ${record.user_id}`,
      description: desc,
      type: "article",
    },
    twitter: {
      card: "summary",
      title: `Adherence prediction // ${record.user_id}`,
      description: desc,
    },
  };
}

export default async function SharedResultPage({ params }: PageProps) {
  const { id } = await params;
  const record = await getShare(id);
  if (!record) notFound();
  return <ShareView record={record} />;
}
