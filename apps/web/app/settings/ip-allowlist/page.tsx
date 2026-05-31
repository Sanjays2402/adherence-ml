import type { Metadata } from "next";
import IpAllowlistClient from "./client";

export const metadata: Metadata = {
  title: "ip allowlist // adherence.ml",
  description:
    "Restrict workspace API and dashboard access to a list of trusted IPs and CIDR ranges.",
};

export const dynamic = "force-dynamic";

export default function IpAllowlistPage() {
  return <IpAllowlistClient />;
}
