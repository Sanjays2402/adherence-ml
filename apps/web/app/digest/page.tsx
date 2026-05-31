import type { Metadata } from "next";
import DigestClient from "./client";

export const metadata: Metadata = {
  title: "weekly digest // adherence.ml",
  description: "Preview your weekly activity email and send a test copy.",
};

export const dynamic = "force-dynamic";

export default function DigestPage() {
  return <DigestClient />;
}
