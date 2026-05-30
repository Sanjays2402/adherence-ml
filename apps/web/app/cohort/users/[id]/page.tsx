import Link from "next/link";
import { notFound } from "next/navigation";
import { CaretLeft } from "@phosphor-icons/react/dist/ssr";
import { api, ApiError } from "@/lib/api";
import type {
  PredictResponse,
  ForecastResponse,
  DeliveryOut,
  DoseClass,
} from "@/lib/types";
import { PageHeader } from "@/components/ui/primitives";
import UserDetailClient from "./client";

export const dynamic = "force-dynamic";

interface Params {
  id: string;
}

function buildSchedule(userId: string, horizonDays: number) {
  // Two doses per day (morning + evening), spanning the horizon.
  // Real call shape that matches the FastAPI ScheduledDose schema.
  const out: {
    dose_id: string;
    scheduled_at: string;
    dose_class: DoseClass;
    dose_strength_mg: number;
  }[] = [];
  const base = new Date();
  base.setMinutes(0, 0, 0);
  for (let d = 0; d < horizonDays; d++) {
    for (const [idx, hour, klass, mg] of [
      [0, 8, "cardio", 10] as const,
      [1, 21, "psych", 25] as const,
    ]) {
      const dt = new Date(base);
      dt.setDate(dt.getDate() + d);
      dt.setHours(hour);
      out.push({
        dose_id: `${userId}-d${d}-${idx}`,
        scheduled_at: dt.toISOString(),
        dose_class: klass,
        dose_strength_mg: mg,
      });
    }
  }
  return out;
}

function buildHistory(userId: string) {
  // Minimal 14-day adherence history so /v1/forecast/user can derive a schedule.
  const out: Array<{
    user_id: string;
    dose_id: string;
    scheduled_at: string;
    taken_at: string | null;
    status: "taken" | "missed" | "late";
    dose_class: DoseClass;
    dose_strength_mg: number;
  }> = [];
  const now = new Date();
  now.setMinutes(0, 0, 0);
  for (let d = 14; d >= 1; d--) {
    for (const [idx, hour, klass, mg] of [
      [0, 8, "cardio", 10] as const,
      [1, 21, "psych", 25] as const,
    ]) {
      const sched = new Date(now);
      sched.setDate(sched.getDate() - d);
      sched.setHours(hour);
      // Deterministic miss pattern based on user id hash + day.
      const seed =
        (userId.charCodeAt(0) || 1) * 31 + d * 7 + idx;
      const missed = seed % 5 === 0;
      out.push({
        user_id: userId,
        dose_id: `${userId}-h${d}-${idx}`,
        scheduled_at: sched.toISOString(),
        taken_at: missed
          ? null
          : new Date(sched.getTime() + 10 * 60_000).toISOString(),
        status: missed ? "missed" : "taken",
        dose_class: klass,
        dose_strength_mg: mg,
      });
    }
  }
  return out;
}

async function safe<T>(p: Promise<T>): Promise<T | { error: string }> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function UserDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id: raw } = await params;
  const userId = decodeURIComponent(raw);
  if (!userId) notFound();

  const schedule = buildSchedule(userId, 3);
  const history = buildHistory(userId);

  const [predict, forecast, deliveries] = await Promise.all([
    safe(
      api.post<PredictResponse>("/v1/predict", {
        user_id: userId,
        schedule,
        top_k_reasons: 3,
      }),
    ),
    safe(
      api.post<ForecastResponse>("/v1/forecast/user", {
        user_id: userId,
        history,
        horizon_days: 7,
        bootstrap_iterations: 200,
        seed: 11,
      }),
    ),
    safe(
      api.get<DeliveryOut[]>(
        `/v1/interventions/deliveries/${encodeURIComponent(userId)}?limit=20`,
      ),
    ),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="cohort // user detail"
        title={userId}
        description="Per-user predicted miss probability stream, projected N-day adherence, and recent intervention deliveries."
        actions={
          <Link
            href="/cohort"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm text-[var(--color-fg)]/80 hover:bg-[var(--color-border)]/40"
          >
            <CaretLeft weight="duotone" size={14} />
            Cohort
          </Link>
        }
      />
      <UserDetailClient
        userId={userId}
        initialPredict={predict}
        initialForecast={forecast}
        initialDeliveries={deliveries}
      />
    </>
  );
}
