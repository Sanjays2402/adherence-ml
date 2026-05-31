import type { Metadata } from "next";
import SessionsClient from "./client";

export const metadata: Metadata = {
  title: "active sessions // adherence.ml",
  description:
    "Review every browser signed into this account, then revoke any one of them or sign out everywhere.",
};

export const dynamic = "force-dynamic";

export default function SessionsPage() {
  return <SessionsClient />;
}
