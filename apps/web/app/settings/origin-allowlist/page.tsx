import type { Metadata } from "next";
import OriginAllowlistClient from "./client";

export const metadata: Metadata = {
  title: "origin allowlist // adherence.ml",
  description:
    "Restrict browser API traffic for this workspace to a list of trusted origins.",
};

export const dynamic = "force-dynamic";

export default function OriginAllowlistPage() {
  return <OriginAllowlistClient />;
}
