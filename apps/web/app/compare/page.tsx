import CompareClient from "./client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Compare patients · adherence.ml",
  description:
    "Score all demo personas in parallel and rank who needs intervention first.",
};

export default function Page() {
  return <CompareClient />;
}
