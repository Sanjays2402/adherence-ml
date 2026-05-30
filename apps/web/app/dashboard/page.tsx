import DashboardClient from "./client";
import { api, ApiError } from "@/lib/api";
import type { OnlineMetricsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  try {
    const initial = await api.get<OnlineMetricsResponse>(
      "/v1/metrics/online?window_hours=168",
    );
    return <DashboardClient initial={initial} />;
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : "unknown";
    return <DashboardClient initial={{ error: msg }} />;
  }
}
