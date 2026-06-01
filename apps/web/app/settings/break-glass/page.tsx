import type { Metadata } from "next";
import BreakGlassClient from "./client";

export const metadata: Metadata = {
  title: "break-glass review // adherence.ml",
  description:
    "Review every cross-tenant admin access into this workspace, with the justification, route, IP, and request ID for each event.",
};

export const dynamic = "force-dynamic";

export default function BreakGlassPage() {
  return <BreakGlassClient />;
}
