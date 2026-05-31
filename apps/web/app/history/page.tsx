import type { Metadata } from "next";
import HistoryClient from "./client";


export const metadata: Metadata = {
  title: "history // adherence.ml",
  description: "Browse, search, replay, and share every model run.",
};

export const dynamic = "force-dynamic";

export default function HistoryPage() {
  return <HistoryClient />;
}
