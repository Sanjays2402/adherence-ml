import type { Metadata } from "next";
import NotificationsClient from "./client";

export const metadata: Metadata = {
  title: "notifications // adherence.ml",
  description: "Activity on your runs, batch jobs, and webhook deliveries.",
};

export const dynamic = "force-dynamic";

export default function NotificationsPage() {
  return <NotificationsClient />;
}
