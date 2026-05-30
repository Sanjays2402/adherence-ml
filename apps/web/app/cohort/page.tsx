import CohortClient from "./client";
import { api, ApiError } from "@/lib/api";
import type { CohortRiskResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CohortPage() {
  try {
    const initial = await api.post<CohortRiskResponse>(
      "/v1/cohort/risk?top_users=20",
      {},
    );
    return <CohortClient initial={initial} />;
  } catch (err) {
    const msg =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : "unknown";
    return <CohortClient initial={{ error: msg }} />;
  }
}
