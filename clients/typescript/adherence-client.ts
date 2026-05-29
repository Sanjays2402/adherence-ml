/**
 * adherence-ml client for Med-Tracker (or any TypeScript consumer).
 *
 * Minimal, zero-dependency wrapper around the REST API. Mirrors the
 * payload shapes in packages/common/adherence_common/schemas.py.
 *
 * Usage:
 *   const client = new AdherenceClient({
 *     baseUrl: process.env.ADHERENCE_URL!,
 *     apiKey: process.env.ADHERENCE_SERVICE_KEY!,  // role >= service
 *   });
 *   const res = await client.predict({
 *     user_id: "u_42",
 *     schedule: [
 *       { dose_id: "d1", scheduled_at: "2026-06-01T08:00:00Z",
 *         dose_class: "cardio", dose_strength_mg: 10 },
 *     ],
 *     top_k_reasons: 3,
 *   });
 *
 * For a fully-typed client run:
 *   uv run python scripts/export_openapi.py > openapi.json
 *   npx openapi-typescript openapi.json -o adherence.types.ts
 */

export type DoseClass =
  | "cardio"
  | "psych"
  | "endocrine"
  | "analgesic"
  | "antibiotic"
  | "supplement"
  | "other";

export type RiskTier = "low" | "medium" | "high";

export interface ScheduledDose {
  dose_id: string;
  scheduled_at: string; // ISO-8601 UTC
  dose_class: DoseClass;
  dose_strength_mg: number;
}

export interface DoseHistoryEvent {
  user_id: string;
  dose_id: string;
  scheduled_at: string;
  taken_at?: string | null;
  status: "taken" | "missed" | "late" | "skipped";
  dose_class: DoseClass;
  dose_strength_mg: number;
}

export interface PredictRequest {
  user_id: string;
  schedule: ScheduledDose[];
  history?: DoseHistoryEvent[];
  top_k_reasons?: number;
}

export interface ReasonCode {
  feature: string;
  contribution: number;
  human: string;
}

export interface DosePrediction {
  dose_id: string;
  scheduled_at: string;
  miss_probability: number;
  risk_tier: RiskTier;
  reasons: ReasonCode[];
}

export interface PredictResponse {
  user_id: string;
  model_version: string;
  predictions: DosePrediction[];
}

export interface AdherenceClientOptions {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AdherenceClient {
  private baseUrl: string;
  private apiKey?: string;
  private bearerToken?: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: AdherenceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.bearerToken = opts.bearerToken;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    if (this.bearerToken) h["authorization"] = `Bearer ${this.bearerToken}`;
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`adherence-ml ${method} ${path} -> ${r.status}: ${text}`);
      }
      return (await r.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  health(): Promise<{ status: string; model_loaded: boolean; version: string }> {
    return this.req("GET", "/healthz");
  }

  predict(req: PredictRequest, modelName = "default"): Promise<PredictResponse> {
    const q = `?model_name=${encodeURIComponent(modelName)}`;
    return this.req("POST", `/v1/predict${q}`, req);
  }

  cohortRisk(
    payload: { events?: DoseHistoryEvent[]; synthetic?: { n_users?: number; n_days?: number; seed?: number } },
    opts: { modelName?: string; topUsers?: number } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams();
    params.set("model_name", opts.modelName ?? "default");
    if (opts.topUsers) params.set("top_users", String(opts.topUsers));
    return this.req("POST", `/v1/cohort/risk?${params.toString()}`, payload);
  }

  explainGlobal(modelName = "default"): Promise<unknown> {
    return this.req("GET", `/v1/explain/global?model_name=${encodeURIComponent(modelName)}`);
  }
}
