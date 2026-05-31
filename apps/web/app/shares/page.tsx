import type { Metadata } from "next";
import SharesClient from "./client";

export const metadata: Metadata = {
  title: "Share links // adherence.ml",
  description: "Public share links you have created. Copy, open, or revoke.",
};

export default function Page() {
  return <SharesClient />;
}
