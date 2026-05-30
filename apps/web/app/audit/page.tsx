import AuditClient from "./client";
import { api, ApiError } from "@/lib/api";
import type { AuditListResponse, AuditStatsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const settle = async <T,>(p: Promise<T>): Promise<T | { error: string }> => {
    try {
      return await p;
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "unknown";
      return { error: msg };
    }
  };
  const [stats, list] = await Promise.all([
    settle(api.get<AuditStatsResponse>("/v1/audit/stats?window_hours=24")),
    settle(api.get<AuditListResponse>("/v1/audit/list?limit=100")),
  ]);
  return <AuditClient initialStats={stats} initialList={list} />;
}
