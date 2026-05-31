import DemoClient from "./client";

export const metadata = {
  title: "Try a sample · adherence.ml",
  description:
    "Score three realistic patient scenarios against the live model and see per-dose risk, top reasons, and latency.",
};

export const dynamic = "force-dynamic";

export default function DemoPage() {
  return <DemoClient />;
}
