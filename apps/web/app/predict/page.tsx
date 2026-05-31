import { Suspense } from "react";
import PredictClient from "./client";
export const dynamic = "force-dynamic";
export default function PredictPage() {
  // Suspense boundary is required because PredictClient calls
  // useSearchParams (?from=<runId> prefill from /history/[id]).
  return (
    <Suspense fallback={null}>
      <PredictClient />
    </Suspense>
  );
}
