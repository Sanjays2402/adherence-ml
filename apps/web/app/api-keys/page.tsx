import type { Metadata } from "next";
import KeysClient from "./client";

export const metadata: Metadata = {
  title: "api keys // adherence.ml",
  description: "Issue, copy, and revoke API keys for the /v1/predict endpoint.",
};

export const dynamic = "force-dynamic";

export default function ApiKeysPage() {
  return <KeysClient />;
}
