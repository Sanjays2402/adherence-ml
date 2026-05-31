import type { Metadata } from "next";
import WebhooksClient from "./client";

export const metadata: Metadata = {
  title: "webhooks // adherence.ml",
  description:
    "Register HTTP endpoints to receive signed event deliveries for every model run.",
};

export const dynamic = "force-dynamic";

export default function WebhooksPage() {
  return <WebhooksClient />;
}
