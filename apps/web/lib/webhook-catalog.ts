// Mirror of packages/common/adherence_common/webhook_events.py.
// Keep this file and the Python catalog in lockstep when adding events.
// The /api/webhooks/event-catalog route serves this when the Python API
// is not reachable so the procurement-facing catalog page always renders.

export type EventStability = "stable" | "beta";

export type CatalogPayloadField = {
  name: string;
  type: string;
  description: string;
};

export type CatalogEvent = {
  event_type: string;
  description: string;
  stability: EventStability;
  version: number;
  since: string;
  payload_example: Record<string, unknown>;
  payload_fields: CatalogPayloadField[];
};

export const CATALOG_VERSION = "2025-05-31";

export const CATALOG_EVENTS: CatalogEvent[] = [
  {
    event_type: "test.ping",
    description:
      "Smoke event emitted by the workspace admin from the webhooks console to verify endpoint connectivity, signing, and IP allowlisting. Always safe to ignore in production receivers.",
    stability: "stable",
    version: 1,
    since: "2025-01-01",
    payload_example: {
      event: "test.ping",
      delivery_id: 12345,
      tenant_id: "acme",
      fired_at: "2025-05-31T16:00:00Z",
      note: "manual test from admin console",
    },
    payload_fields: [
      { name: "event", type: "string", description: "Always 'test.ping'." },
      { name: "delivery_id", type: "integer", description: "Unique delivery row id; use for dedupe." },
      { name: "tenant_id", type: "string", description: "Workspace that triggered the ping." },
      { name: "fired_at", type: "string", description: "ISO-8601 UTC timestamp." },
      { name: "note", type: "string", description: "Free-text label set by the admin (optional)." },
    ],
  },
  {
    event_type: "intervention.recommended",
    description:
      "Fired when the inference pipeline recommends a clinical intervention for a patient based on a fresh risk score. Includes patient external id, risk tier, and the model version that produced the decision. Receivers typically route this into a care-team task queue.",
    stability: "stable",
    version: 1,
    since: "2025-02-15",
    payload_example: {
      event: "intervention.recommended",
      delivery_id: 12346,
      tenant_id: "acme",
      patient_external_id: "P-00042",
      intervention_id: 991,
      risk_tier: "high",
      risk_score: 0.81,
      model_version: "ridge-v7",
      recommended_at: "2025-05-31T16:00:00Z",
    },
    payload_fields: [
      { name: "event", type: "string", description: "Always 'intervention.recommended'." },
      { name: "delivery_id", type: "integer", description: "Unique delivery row id." },
      { name: "tenant_id", type: "string", description: "Workspace owning the patient." },
      { name: "patient_external_id", type: "string", description: "Stable patient identifier as supplied by the customer." },
      { name: "intervention_id", type: "integer", description: "Internal intervention row id." },
      { name: "risk_tier", type: "string", description: "One of 'low', 'medium', 'high'." },
      { name: "risk_score", type: "number", description: "Calibrated probability in [0,1]." },
      { name: "model_version", type: "string", description: "Model used to score this patient." },
      { name: "recommended_at", type: "string", description: "ISO-8601 UTC." },
    ],
  },
  {
    event_type: "intervention.high_risk",
    description:
      "Fired when a patient's calibrated risk score crosses the high-risk threshold configured for the workspace. Distinct from intervention.recommended in that it is a threshold-crossing signal (raw risk), not a recommended clinical action. Receivers typically use this to wake on-call clinicians via paging integrations.",
    stability: "stable",
    version: 1,
    since: "2025-03-01",
    payload_example: {
      event: "intervention.high_risk",
      delivery_id: 12349,
      tenant_id: "acme",
      patient_external_id: "P-00042",
      patient_id: "P-00042",
      risk: 0.93,
      risk_score: 0.93,
      threshold: 0.85,
      model_version: "ridge-v7",
      detected_at: "2025-05-31T16:00:00Z",
    },
    payload_fields: [
      { name: "event", type: "string", description: "Always 'intervention.high_risk'." },
      { name: "delivery_id", type: "integer", description: "Unique delivery row id." },
      { name: "tenant_id", type: "string", description: "Workspace owning the patient." },
      { name: "patient_external_id", type: "string", description: "Stable patient identifier." },
      { name: "risk_score", type: "number", description: "Calibrated probability in [0,1]." },
      { name: "threshold", type: "number", description: "Workspace high-risk threshold that was crossed." },
      { name: "model_version", type: "string", description: "Model used to score this patient." },
      { name: "detected_at", type: "string", description: "ISO-8601 UTC." },
    ],
  },
  {
    event_type: "run.created",
    description:
      "Fired when a new inference run completes for a cohort or individual prediction request. Carries the run id so receivers can fetch detail via /v1/predict/{run_id}.",
    stability: "stable",
    version: 1,
    since: "2025-01-01",
    payload_example: {
      event: "run.created",
      delivery_id: 12347,
      tenant_id: "acme",
      run_id: "r_01HXYZ",
      kind: "predict",
      rows: 1,
      created_at: "2025-05-31T16:00:00Z",
    },
    payload_fields: [
      { name: "event", type: "string", description: "Always 'run.created'." },
      { name: "delivery_id", type: "integer", description: "Unique delivery row id." },
      { name: "tenant_id", type: "string", description: "Workspace that owns the run." },
      { name: "run_id", type: "string", description: "Run identifier; opaque to the receiver." },
      { name: "kind", type: "string", description: "'predict' | 'forecast' | 'batch'." },
      { name: "rows", type: "integer", description: "Number of rows scored in this run." },
      { name: "created_at", type: "string", description: "ISO-8601 UTC." },
    ],
  },
  {
    event_type: "drift.detected",
    description:
      "Fired when the online drift monitor crosses the configured threshold for a given feature or output distribution. Receivers typically open a ticket or page on-call.",
    stability: "beta",
    version: 1,
    since: "2025-04-01",
    payload_example: {
      event: "drift.detected",
      delivery_id: 12348,
      tenant_id: "acme",
      feature: "days_since_last_refill",
      metric: "psi",
      value: 0.27,
      threshold: 0.2,
      window_hours: 24,
      detected_at: "2025-05-31T16:00:00Z",
    },
    payload_fields: [
      { name: "event", type: "string", description: "Always 'drift.detected'." },
      { name: "delivery_id", type: "integer", description: "Unique delivery row id." },
      { name: "tenant_id", type: "string", description: "Workspace owning the monitored model." },
      { name: "feature", type: "string", description: "Feature or output name that drifted." },
      { name: "metric", type: "string", description: "Drift metric (psi, kl, ks, etc)." },
      { name: "value", type: "number", description: "Measured value of the metric." },
      { name: "threshold", type: "number", description: "Configured alert threshold." },
      { name: "window_hours", type: "integer", description: "Observation window." },
      { name: "detected_at", type: "string", description: "ISO-8601 UTC." },
    ],
  },
  {
    event_type: "api_key.rotated",
    description:
      "Fired when a workspace admin rotates an API key. Receivers can use this to update their secret stores or to alert security teams to unexpected rotations.",
    stability: "stable",
    version: 1,
    since: "2025-03-10",
    payload_example: {
      event: "api_key.rotated",
      delivery_id: 12349,
      tenant_id: "acme",
      key_name: "ci-runner",
      rotated_by: "alice@acme.com",
      rotated_at: "2025-05-31T16:00:00Z",
    },
    payload_fields: [
      { name: "event", type: "string", description: "Always 'api_key.rotated'." },
      { name: "delivery_id", type: "integer", description: "Unique delivery row id." },
      { name: "tenant_id", type: "string", description: "Workspace owning the key." },
      { name: "key_name", type: "string", description: "Human-readable key label." },
      { name: "rotated_by", type: "string", description: "Actor email or principal id." },
      { name: "rotated_at", type: "string", description: "ISO-8601 UTC." },
    ],
  },
  {
    event_type: "member.invited",
    description:
      "Fired when an admin invites a new member to the workspace. Receivers can use this to provision downstream systems (JIRA, Slack channels) in lock-step with onboarding.",
    stability: "stable",
    version: 1,
    since: "2025-03-10",
    payload_example: {
      event: "member.invited",
      delivery_id: 12350,
      tenant_id: "acme",
      invitee_email: "bob@acme.com",
      role: "member",
      invited_by: "alice@acme.com",
      invited_at: "2025-05-31T16:00:00Z",
    },
    payload_fields: [
      { name: "event", type: "string", description: "Always 'member.invited'." },
      { name: "delivery_id", type: "integer", description: "Unique delivery row id." },
      { name: "tenant_id", type: "string", description: "Workspace receiving the new member." },
      { name: "invitee_email", type: "string", description: "Email address invited." },
      { name: "role", type: "string", description: "Initial role: owner | admin | member | viewer." },
      { name: "invited_by", type: "string", description: "Actor email or principal id." },
      { name: "invited_at", type: "string", description: "ISO-8601 UTC." },
    ],
  },
];

/**
 * Event types customers may subscribe to from the webhook console and
 * the `/v1/webhooks` API. Derived directly from the stable rows of
 * `CATALOG_EVENTS` so publishing a new stable event in the catalog
 * automatically opens it for subscription. Beta events are excluded
 * to keep the subscription surface stable for procurement reviews.
 */
export const STABLE_EVENT_TYPES: readonly string[] = CATALOG_EVENTS.filter(
  (e) => e.stability === "stable",
).map((e) => e.event_type);

export function isSubscribableEvent(s: string): boolean {
  return STABLE_EVENT_TYPES.includes(s);
}

export function catalogSummary() {
  const stable = CATALOG_EVENTS.filter((e) => e.stability === "stable").length;
  const beta = CATALOG_EVENTS.filter((e) => e.stability === "beta").length;
  return {
    version: CATALOG_VERSION,
    count: CATALOG_EVENTS.length,
    stable,
    beta,
    stable_event_types: CATALOG_EVENTS.filter((e) => e.stability === "stable").map(
      (e) => e.event_type,
    ),
  };
}
