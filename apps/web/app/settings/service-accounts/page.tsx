import type { Metadata } from "next";
import ServiceAccountsClient from "./client";

export const metadata: Metadata = {
  title: "service accounts // adherence.ml",
  description:
    "Per-workspace register of non-human identities. Owner, system of record, credential kind, scopes, rotation cadence, last rotated, last reviewed, last used, vault status, overdue tracking, CSV export, audit-logged mutations.",
};

export const dynamic = "force-dynamic";

export default function ServiceAccountsPage() {
  return <ServiceAccountsClient />;
}
