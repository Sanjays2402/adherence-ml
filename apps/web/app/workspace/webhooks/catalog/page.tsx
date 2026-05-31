import type { Metadata } from "next";
import CatalogClient from "./client";

export const metadata: Metadata = {
  title: "webhook event catalog // adherence.ml",
  description:
    "Canonical catalog of every event type this API emits, with payload schema and example bodies. Subscriptions reject event types not listed here.",
};

export const dynamic = "force-dynamic";

export default function WebhookEventCatalogPage() {
  return <CatalogClient />;
}
