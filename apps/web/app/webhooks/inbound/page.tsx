import type { Metadata } from "next";

import InboundWebhooksClient from "./client";

export const metadata: Metadata = {
  title: "inbound webhooks // adherence.ml",
  description:
    "Audit which partner sources are allowed to post outcome events, and whether each one is HMAC signed and IP restricted.",
};

export const dynamic = "force-dynamic";

export default function InboundWebhooksPage() {
  return <InboundWebhooksClient />;
}
