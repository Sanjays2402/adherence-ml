import type { Metadata } from "next";
import DocsClient from "./client";

export const metadata: Metadata = {
  title: "API docs // adherence.ml",
  description: "Reference for every /v1 endpoint with copy-paste curl and live key testing.",
};

export const dynamic = "force-dynamic";

export default function DocsPage() {
  return <DocsClient />;
}
