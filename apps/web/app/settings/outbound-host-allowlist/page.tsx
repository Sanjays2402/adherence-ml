import type { Metadata } from "next";
import OutboundHostAllowlistClient from "./client";

export const metadata: Metadata = {
  title: "outbound host allowlist // adherence.ml",
  description:
    "Restrict outbound webhook destinations for this workspace to a list of trusted hostnames.",
};

export const dynamic = "force-dynamic";

export default function OutboundHostAllowlistPage() {
  return <OutboundHostAllowlistClient />;
}
