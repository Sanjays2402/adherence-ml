// Mirrors the FastAPI Pydantic models we render against.

export type RiskTier = "low" | "medium" | "high";
export type DoseClass =
  | "cardio" | "neuro" | "endocrine" | "psych"
  | "antibiotic" | "supplement" | "other";

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
  dose_class?: DoseClass;
}

export interface PredictResponse {
  user_id: string;
  model_version: string;
  predictions: DosePrediction[];
}

export interface CalibrationBin {
  p_lo: number; p_hi: number; n: number;
  mean_pred: number; miss_rate: number;
}

export interface OnlineMetricsResponse {
  window_hours: number;
  n_predictions: number;
  n_matched: number;
  n_positives: number;
  base_rate: number | null;
  auc: number | null;
  brier: number | null;
  log_loss: number | null;
  ece: number | null;
  calibration: CalibrationBin[];
  by_model: Record<string, { n: number; auc: number | null; brier: number; miss_rate: number }>;
}

export interface FeatureImportance {
  feature: string;
  human: string;
  gain_xgb: number;
  gain_lgb: number;
  mean_abs_shap: number;
  rank: number;
}

export interface ExplainGlobalResponse {
  model_name: string;
  model_version: string;
  sample_size: number;
  features: FeatureImportance[];
}

export interface ExplainSampleRow {
  miss_probability: number;
  feature_values: Record<string, number>;
  shap_values: Record<string, number>;
}

export interface ExplainSampleResponse {
  model_name: string;
  model_version: string;
  rows: ExplainSampleRow[];
}

export interface CohortBucket {
  key: string;
  n_doses: number;
  mean_miss_probability: number;
  pct_high_risk: number;
  pct_medium_risk: number;
}

export interface CohortRiskResponse {
  model_name: string;
  model_version: string;
  total_doses: number;
  overall_mean_risk: number;
  by_dose_class: CohortBucket[];
  by_time_bucket: CohortBucket[];
  top_users: CohortBucket[];
}

export interface DailyForecast {
  date: string;
  n_doses: number;
  mean_miss_probability: number;
  projected_adherence_rate: number;
  high_risk_count: number;
}

export interface ForecastResponse {
  user_id: string;
  model_name: string;
  model_version: string;
  horizon_days: number;
  n_doses_scored: number;
  overall_projected_adherence_rate: number;
  overall_adherence_ci_low: number;
  overall_adherence_ci_high: number;
  by_day: DailyForecast[];
  schedule_source: string;
}

export interface InterventionItem {
  action: string;
  score: number;
  target_dose_ids: string[];
  reason: string;
  channel: string;
  lead_time_minutes: number;
  deferred_until: string | null;
  deferred_reason: string | null;
  delivery_id: number | null;
  suppressed: boolean;
  suppress_reason: string | null;
}

export interface AuditRow {
  id: number;
  request_id: string;
  route: string;
  user_id: string;
  caller: string;
  caller_role: string;
  model_name: string;
  model_version: string;
  n_doses: number;
  mean_miss_prob: number | null;
  max_miss_prob: number | null;
  high_risk_count: number;
  latency_ms: number | null;
  ok: boolean;
  error: string | null;
  created_at: string;
}

export interface AuditListResponse {
  n: number;
  items: AuditRow[];
}

export interface AuditStatsResponse {
  window_hours: number;
  n_calls: number;
  n_errors: number;
  error_rate: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  mean_miss_prob: number | null;
  high_risk_calls: number;
  by_model: Record<string, number>;
  by_route: Record<string, number>;
}

export interface DeliveryOut {
  id: number;
  request_id: string;
  user_id: string;
  action: string;
  channel: string;
  score: number;
  target_dose_ids: string[];
  reason: string | null;
  state: string;
  snooze_until: string | null;
  acked_by: string | null;
  created_at: string;
  updated_at: string;
}
