import type { Metadata } from "next";
import SessionPolicyClient from "./client";

export const metadata: Metadata = {
  title: "session policy // adherence.ml",
  description:
    "Cap how long a signed-in session is honoured inside this workspace, independent of the global default.",
};

export const dynamic = "force-dynamic";

export default function SessionPolicyPage() {
  return <SessionPolicyClient />;
}
