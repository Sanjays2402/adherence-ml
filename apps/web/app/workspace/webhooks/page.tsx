import type { Metadata } from "next";
import WebhooksClient from "./client";

export const metadata: Metadata = {
  title: "webhooks // adherence.ml",
  description:
    "Manage outbound webhook endpoints, browse signed delivery attempts, and replay failed deliveries.",
};

export const dynamic = "force-dynamic";

export default function WorkspaceWebhooksPage() {
  return <WebhooksClient />;
}
