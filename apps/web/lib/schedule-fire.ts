/**
 * Shared firing logic for scheduled prediction jobs.
 *
 * Calls the upstream FastAPI predictor with the saved payload, appends a
 * `predict` record to history tagged `scheduled`, and updates the
 * schedule's next_run_at / counters via recordRun().
 */
import { apiFetch, ApiError } from "@/lib/api";
import { appendRun, newRunId } from "@/lib/runs-store";
import { recordRun, type Schedule, type ScheduleRun } from "@/lib/schedules-store";
import { emit } from "@/lib/webhook-dispatch";

export async function fireSchedule(sch: Schedule): Promise<ScheduleRun> {
  const t0 = Date.now();
  try {
    const data = await apiFetch<Record<string, unknown>>("/v1/predict", {
      method: "POST",
      body: JSON.stringify(sch.payload),
      headers: { "content-type": "application/json" },
    });
    const latency = Date.now() - t0;
    const risk = typeof data.risk === "number" ? (data.risk as number) : null;
    const band =
      typeof data.band === "string"
        ? data.band
        : typeof data.risk_band === "string"
          ? (data.risk_band as string)
          : "";
    const runId = newRunId();
    await appendRun({
      id: runId,
      created_at: t0,
      kind: "predict",
      title: `${sch.name} (scheduled)`,
      summary:
        risk !== null
          ? `risk ${(risk * 100).toFixed(1)}% ${band}`.trim()
          : band || "scheduled run",
      user_id: sch.payload.user_id,
      latency_ms: latency,
      payload: {
        request: sch.payload,
        response: data,
        via: "schedule",
        schedule_id: sch.id,
      },
      tags: ["scheduled", `sch:${sch.id}`, sch.cadence],
    });
    // best-effort webhook fan-out
    try {
      await emit("run.created", {
        run_id: runId,
        kind: "predict",
        via: "schedule",
        schedule_id: sch.id,
      });
    } catch {
      // never let fan-out break the tick
    }
    const result: ScheduleRun = {
      at: t0,
      ok: true,
      run_id: runId,
      latency_ms: latency,
      error: null,
    };
    await recordRun(sch.id, result);
    return result;
  } catch (err) {
    const latency = Date.now() - t0;
    const result: ScheduleRun = {
      at: t0,
      ok: false,
      run_id: null,
      latency_ms: latency,
      error:
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : "upstream error",
    };
    await recordRun(sch.id, result);
    return result;
  }
}
