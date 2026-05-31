/**
 * run-clone.ts
 *
 * Pulls the original request inputs out of a stored RunRecord so the
 * user can prefill the /predict form and re-run a previous job without
 * retyping the schedule. Today we only know how to clone "predict"
 * (and "demo", which uses the same payload shape) runs.
 *
 * Shape consumed:
 *   payload = { request: { user_id, top_k_reasons, schedule: Dose[] }, response: ... }
 * Shape returned (matches the /predict client Row + form):
 *   { user_id, top_k, rows: [{ dose_id, scheduled_at, dose_class, dose_strength_mg }] }
 */
import type { RunRecord } from "@/lib/runs-store";

export interface ClonedPredictInputs {
  user_id: string;
  top_k: number;
  rows: Array<{
    dose_id: string;
    scheduled_at: string; // datetime-local friendly: YYYY-MM-DDTHH:mm
    dose_class: string;
    dose_strength_mg: number;
  }>;
}

const CLONEABLE_KINDS = new Set(["predict", "demo"]);

/** Returns true when this run shape can be re-run via /predict. */
export function isCloneable(rec: Pick<RunRecord, "kind" | "payload">): boolean {
  if (!CLONEABLE_KINDS.has(rec.kind)) return false;
  const req = pickRequest(rec.payload);
  if (!req || typeof req !== "object") return false;
  const sched = (req as { schedule?: unknown }).schedule;
  return Array.isArray(sched) && sched.length > 0;
}

function pickRequest(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  // proxy route stores { request, response }
  if (p.request && typeof p.request === "object") return p.request;
  // some callers store the request flat
  if ("schedule" in p) return p;
  return null;
}

/** Convert an ISO string into a YYYY-MM-DDTHH:mm value the <input type=datetime-local> wants. */
function toLocalInput(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

/**
 * Extract a /predict-ready set of inputs from a RunRecord.
 * Returns null if the run cannot be cloned.
 */
export function cloneFromRun(
  rec: Pick<RunRecord, "kind" | "payload" | "user_id">,
): ClonedPredictInputs | null {
  if (!isCloneable(rec)) return null;
  const req = pickRequest(rec.payload) as {
    user_id?: unknown;
    top_k_reasons?: unknown;
    schedule?: Array<Record<string, unknown>>;
  };
  const schedule = Array.isArray(req.schedule) ? req.schedule : [];
  const rows = schedule.slice(0, 500).map((row, idx) => {
    const dose_id =
      typeof row.dose_id === "string" && row.dose_id ? row.dose_id : `d${idx + 1}`;
    const scheduled_at =
      typeof row.scheduled_at === "string" ? toLocalInput(row.scheduled_at) : "";
    const dose_class =
      typeof row.dose_class === "string" ? row.dose_class : "other";
    const raw = row.dose_strength_mg;
    const dose_strength_mg =
      typeof raw === "number" && Number.isFinite(raw) ? raw : Number(raw) || 0;
    return { dose_id, scheduled_at, dose_class, dose_strength_mg };
  });
  const user_id =
    (typeof req.user_id === "string" && req.user_id) ||
    rec.user_id ||
    "demo-user-001";
  const top_k_raw = req.top_k_reasons;
  const top_k =
    typeof top_k_raw === "number" && Number.isFinite(top_k_raw)
      ? Math.max(0, Math.min(50, Math.floor(top_k_raw)))
      : 3;
  return { user_id, top_k, rows };
}
