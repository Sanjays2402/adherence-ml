import BatchClient from "./client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Batch scoring // adherence.ml",
  description: "Upload a CSV of scheduled doses and download adherence risk predictions.",
};

export default function BatchPage() {
  return <BatchClient />;
}
