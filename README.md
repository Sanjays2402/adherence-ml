# adherence-ml

ML risk scoring for medication adherence. Predicts which upcoming doses a user
is likely to miss in the next 24 hours and turns those scores into ranked
interventions.

![landing](docs/screenshots/landing.png)

## What it does

The service ingests scheduled-dose events from a med-tracker source, builds
per-user temporal features, and trains an XGBoost + LightGBM ensemble whose
probabilities are calibrated (isotonic) before serving. The FastAPI app exposes
`/v1/predict` for single users and `/v1/cohort/risk` for population sweeps,
plus online quality metrics (AUC, Brier, log-loss, calibration drift) under
`/v1/metrics`. Per-dose SHAP attributions are returned at predict time and
aggregated globally under `/v1/explain`. High-risk doses can be fanned out into
a notification queue with risk-tier policies, quiet hours, per-user mutes, and
notification budgets. Every prediction, override, and delivery is recorded in
an append-only audit log with CSV export.

## Features

- Cohort browser (`/cohort`) backed by `POST /v1/cohort/risk` with CSV export
  via `/v1/cohort/risk/export`.
- Predict endpoint with batch variant (`POST /v1/predict`, `POST /v1/predict/batch`).
- SHAP-style explainer at predict time and aggregated under
  `/v1/explain/global` and `/v1/explain/sample`, surfaced in the `/explain`
  page as a waterfall chart.
- Intervention queue (`/v1/interventions`, `/v1/interventions/from-predictions`)
  with risk-tier policies, quiet-hours, notification budgets, mutes, ack, and
  expiry sweeps.
- Append-only audit log with stats, listing, and CSV export
  (`/v1/audit/list`, `/v1/audit/stats`, `/v1/audit/export.csv`).
- Calibration and feature-importance pages backed by PNG plots
  (`/v1/plots/calibration.png`, `/v1/plots/importance.png`) and
  `/v1/metrics/calibration-drift`.
- Drift check endpoint (`/v1/drift/check`) with PSI threshold + optional
  webhook.
- Outbound webhook subscriptions with replay (`/v1/webhooks/outbound/*`) and
  inbound med-tracker callback (`/v1/webhooks/medtracker/event`).
- A/B experiments scaffolding (`/v1/experiments/*`).
- Async training jobs via Redis/RQ worker (`POST /v1/train/async`).
- Prometheus metrics (`/metrics`) and OpenTelemetry tracing.

## Stack

- **Web**: Next.js 15 (App Router, React 19), Tailwind v4, Recharts, SWR,
  Phosphor icons. Server-side proxy to the API so API keys never reach the
  browser.
- **API**: FastAPI + Uvicorn, Pydantic v2, SQLAlchemy 2 + Alembic, JWT
  (PyJWT) + API-key auth, Prometheus + OTLP.
- **ML**: scikit-learn, XGBoost, LightGBM, SHAP, isotonic calibration, MLflow
  for tracking, joblib for on-disk model artifacts.
- **Infra**: Postgres 16, Redis 7 (RQ queues), MLflow server, Docker Compose
  for dev. Terraform + Helm scaffolding under `infra/`.
- **CLI**: Typer (`adherence-ml`) for generate-data, train, backtest, predict,
  serve.

## Architecture

```
 med-tracker events ──▶ packages/data ──▶ packages/features ──▶ training frame
                                                                   │
                                                                   ▼
                                                  services/trainer (XGB+LGBM
                                                  ensemble + isotonic calib)
                                                                   │
                                                                   ▼
                                                  models/registry (joblib +
                                                  *_index.json) + MLflow
                                                                   │
            ┌──────────────────────────────────────────────────────┘
            ▼
  services/api  ── /v1/predict, /v1/cohort, /v1/explain, /v1/metrics ──┐
            │                                                          │
            ├──▶ Postgres (audit, policies, mutes, deliveries,         │
            │             experiments, subscriptions)                  │
            ├──▶ Redis + RQ ──▶ services/inference_worker              │
            │                                                          │
            └──────────────────────────────────────────────────────▶ apps/web
                                                              (Next.js 15)
```

Features are derived strictly from events with `event_time < scheduled_at` to
avoid leakage. The trainer registers each model under a name (e.g. `default`)
with a versioned joblib file plus an `<name>_index.json` pointer; the API
loads the active version on first request and supports rollback via
`/v1/admin/models/{name}/rollback`.

## Quick start

Prereqs: Python 3.11 or 3.12, [uv](https://github.com/astral-sh/uv), Node 20+,
pnpm 9, Docker (optional, for Postgres/Redis/MLflow).

```bash
git clone <repo> adherence-ml
cd adherence-ml

# Python install (creates .venv, installs all packages + services)
uv sync --extra dev

# Env
cp .env.example .env

# Option A: full stack via Docker (postgres + redis + mlflow + api + worker + trainer)
./scripts/dev_up.sh

# Option B: local Python only
#   Train a baseline on synthetic data
./scripts/train_baseline.sh
#   Run the API
uv run adherence-ml serve   # or: uv run uvicorn adherence_api.app:create_app --factory --port 7421
```

Web app (separate terminal):

```bash
cd apps/web
cp .env.example .env.local       # set ADHERENCE_API_BASE + ADHERENCE_API_KEY
pnpm install
pnpm dev                          # http://localhost:3000
```

End-to-end smoke (trains a `demo` model and runs a 3-dose predict):

```bash
./scripts/demo_predict.sh
```

## Configuration

API (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADHERENCE_ENV` | `dev` | Environment tag |
| `ADHERENCE_LOG_LEVEL` | `INFO` | Log level |
| `ADHERENCE_API_HOST` | `0.0.0.0` | Bind host |
| `ADHERENCE_API_PORT` | `7421` | Bind port |
| `ADHERENCE_JWT_SECRET` | (required) | HMAC secret for `/v1/admin/token` |
| `ADHERENCE_JWT_ALG` | `HS256` | JWT algorithm |
| `ADHERENCE_JWT_TTL_SECONDS` | `3600` | JWT lifetime |
| `ADHERENCE_API_KEYS` | dev placeholders | `role:key` pairs, comma-separated |
| `ADHERENCE_DB_URL` | local Postgres DSN | SQLAlchemy URL (psycopg) |
| `ADHERENCE_REDIS_URL` | `redis://localhost:6379/0` | Redis for RQ + rate limit |
| `ADHERENCE_MLFLOW_TRACKING_URI` | `http://localhost:5000` | MLflow server |
| `ADHERENCE_MODEL_REGISTRY` | `./models/registry` | Joblib registry path |
| `ADHERENCE_DRIFT_WEBHOOK_URL` | empty | Drift alert webhook |
| `ADHERENCE_DRIFT_PSI_THRESHOLD` | `0.2` | PSI alert threshold |
| `MEDTRACKER_BASE_URL` | empty | Upstream event source |
| `MEDTRACKER_API_KEY` | empty | Upstream auth |
| `OTEL_SERVICE_NAME` | `adherence-ml` | OTel service name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | OTLP collector |
| `ADHERENCE_SENTRY_DSN` | empty | Sentry DSN; empty disables shipping |
| `ADHERENCE_SENTRY_ENVIRONMENT` | falls back to `ADHERENCE_ENV` | Sentry environment tag |
| `ADHERENCE_SENTRY_TRACES_SAMPLE_RATE` | `0.0` | Performance trace sample rate (0.0 to 1.0) |
| `ADHERENCE_SENTRY_PROFILES_SAMPLE_RATE` | `0.0` | Profiling sample rate (0.0 to 1.0) |

Web (`apps/web/.env.local`):

| Variable | Purpose |
| --- | --- |
| `ADHERENCE_API_BASE` | Backend FastAPI base URL (server-side only) |
| `ADHERENCE_API_KEY` | Admin-role API key for protected routes |

## Scripts

CLI (`uv run adherence-ml ...`):

| Command | What it does |
| --- | --- |
| `version` | Print package version |
| `generate-data` | Write synthetic events parquet to `data/generated/` |
| `train` | Train ensemble (synthetic or from `--events`), register under `--name` |
| `backtest` | Time-series backtest with `--test-days` holdout |
| `predict` | Score a JSON schedule for a user_id, optional `--history` |
| `serve` | Run the FastAPI app via uvicorn |
| `list-models` | List registered model versions |

Shell helpers in `scripts/`:

- `dev_up.sh` — `docker compose -f infra/docker/docker-compose.dev.yml up --build`
- `train_baseline.sh` — generate-data + train `default` + list-models
- `demo_predict.sh` — train `demo` then call `predict` on 3 sample doses
- `export_openapi.py` — dump the OpenAPI schema

Web (`apps/web`, pnpm):

| Script | What it does |
| --- | --- |
| `pnpm dev` | Next dev server on :3000 |
| `pnpm build` | Production build |
| `pnpm start` | Production server on :3000 |
| `pnpm lint` | `next lint` |
| `pnpm typecheck` | `tsc --noEmit` |

## API

All routes are under `/v1` unless noted. Auth is API key (`x-api-key`) or JWT
(`Authorization: Bearer ...`); roles are `admin`, `service`, `viewer`.

Health & ops

- `GET /healthz`, `GET /livez`
- `GET /metrics` (Prometheus text)

Predict

- `POST /v1/predict`
- `POST /v1/predict/batch`

Cohort

- `POST /v1/cohort/risk`
- `POST /v1/cohort/risk/export` (CSV)

Explain

- `GET /v1/explain/global`
- `GET /v1/explain/sample`

Forecast

- `POST /v1/forecast/user`

Train (admin)

- `POST /v1/train`
- `POST /v1/train/async`

Drift

- `POST /v1/drift/check`

Plots

- `GET /v1/plots/calibration.png`
- `GET /v1/plots/importance.png`

Metrics (online quality)

- `GET /v1/metrics/online`
- `GET /v1/metrics/online/report`
- `GET /v1/metrics/calibration-drift`

Audit (admin)

- `GET /v1/audit/list`
- `GET /v1/audit/stats`
- `GET /v1/audit/shadow`
- `GET /v1/audit/export.csv`

Interventions

- `POST /v1/interventions`
- `POST /v1/interventions/from-predictions`
- `POST /v1/interventions/{delivery_id}/ack`
- `GET  /v1/interventions/deliveries/{user_id}`
- `GET  /v1/interventions/stats`
- `POST /v1/interventions/expire`

Policies

- `GET /v1/policies/risk`, `PUT /v1/policies/risk`, `DELETE /v1/policies/risk`
- `PUT/GET/DELETE /v1/policies/quiet-hours/{user_id}`
- `PUT/GET/DELETE /v1/policies/notification-budget/{user_id}`

Mutes

- `PUT/GET/DELETE /v1/users/{user_id}/mute`
- `GET /v1/admin/mutes`

Experiments

- `POST /v1/experiments`, `GET /v1/experiments`, `GET /v1/experiments/{key}`
- `PATCH /v1/experiments/{key}/state`
- `POST /v1/experiments/{key}/assign`
- `POST /v1/experiments/{key}/events`
- `GET /v1/experiments/{key}/results`

Webhooks

- Inbound: `POST /v1/webhooks/medtracker/event`, `GET /v1/webhooks/medtracker/recent`
- Outbound: `PUT/GET /v1/webhooks/outbound/subscriptions`,
  `DELETE /v1/webhooks/outbound/subscriptions/{name}`,
  `GET /v1/webhooks/outbound/deliveries`,
  `POST /v1/webhooks/outbound/deliveries/{delivery_id}/replay`,
  `POST /v1/webhooks/outbound/test-send`

Admin

- `POST /v1/admin/token`
- `GET  /v1/admin/models`
- `POST /v1/admin/models/{name}/rollback`
- `POST /v1/admin/api-keys`, `GET /v1/admin/api-keys`,
  `POST /v1/admin/api-keys/{name}/revoke`
- `POST /v1/admin/audit/retention`

The full OpenAPI is available at `/docs` (Swagger) and `/openapi.json`, or
dump it with `uv run python scripts/export_openapi.py`.

## Model

Per-dose binary classifier (`label = dose missed`). The ensemble averages
calibrated XGBoost and LightGBM probabilities (`packages/models/adherence_models/ensemble.py`),
fit with isotonic calibration on a held-out slice
(`packages/models/adherence_models/calibration.py`). Training and evaluation
metrics include ROC AUC, PR AUC, Brier score, log loss, and reliability bins
(`packages/eval/adherence_eval`).

Features (`packages/features/adherence_features/engineering.py`,
`FEATURE_COLUMNS`):

```
hour_sin, hour_cos, dow_sin, dow_cos, is_weekend,
time_bucket_idx, dose_class_idx, dose_strength_mg,
streak_taken, streak_missed,
recent_miss_rate_7d, recent_miss_rate_24h, recent_late_rate_7d,
doses_today_so_far, doses_yesterday,
minutes_since_last_dose, minutes_since_last_taken,
sleep_window_proxy, n_classes_user, user_n_doses_history
```

All features are computed from events strictly before `scheduled_at` to avoid
leakage.

Artifacts live in `models/registry/` as
`<name>__<UTC timestamp>.joblib` with a sibling `<name>_index.json` pointing at
the active version. The registry is loaded by `packages/models/adherence_models/registry.py`.
Rollback via `POST /v1/admin/models/{name}/rollback`.

Retrain:

```bash
# synthetic
uv run adherence-ml train --synthetic --users 5000 --days 60 --name default

# from a parquet of real events
uv run adherence-ml train --no-synthetic --events data/events.parquet --name default

# time-series backtest
uv run adherence-ml backtest --synthetic --users 2000 --days 45 --test-days 7
```

## Project structure

```
adherence-ml/
├── apps/
│   └── web/                    # Next.js 15 dashboard (cohort, predict,
│                               # explain, interventions, audit, dashboard)
├── packages/
│   ├── common/                 # settings, logging, telemetry, constants
│   ├── data/                   # synthetic generator, loaders, medtracker
│   ├── features/               # engineering.py (FEATURE_COLUMNS), drift.py
│   ├── models/                 # ensemble, calibration, registry, promotion
│   ├── eval/                   # metrics + reliability plots
│   └── explain/                # SHAP wrappers
├── services/
│   ├── api/                    # FastAPI app + routes/
│   ├── trainer/                # training pipeline (run_training, run_backtest)
│   ├── inference_worker/       # predict_doses, RQ worker
│   └── cli/                    # adherence-ml Typer CLI
├── clients/
│   ├── python/                 # generated Python client
│   └── typescript/             # generated TS client
├── infra/
│   ├── docker/                 # Dockerfile, Dockerfile.{trainer,worker},
│   │                           # docker-compose.dev.yml
│   ├── helm/adherence-ml/
│   └── terraform/
├── scripts/                    # dev_up.sh, train_baseline.sh,
│                               # demo_predict.sh, export_openapi.py
├── models/registry/            # joblib artifacts + *_index.json
├── data/samples/               # sample events
├── mlruns_sample/              # sample MLflow run
├── tests/                      # unit, property (hypothesis), integration
├── docs/                       # screenshots, diagrams
├── pyproject.toml              # uv-managed; defines adherence-ml entrypoint
└── uv.lock
```

## Operations

Deployment and on-call notes for running adherence-ml in production.

**Deploy.** Build the API image and ship via `infra/helm/adherence-ml`. The chart provisions API + worker + trainer deployments, a PodDisruptionBudget, optional HPA, ingress, and projects environment from a ConfigMap plus a Secret. Override the image tag and secrets per environment with `--values`.

**Scale.** API replicas default to 2 (`replicaCount.api`). Enable horizontal autoscaling with `autoscaling.enabled=true`; the api HPA scales on CPU (target 70 percent) and memory (target 80 percent) so a slow leak triggers scale-out instead of OOMKills (set `autoscaling.targetMemoryUtilizationPercentage=0` to opt out). The HPA carries a `behavior` block that biases scale-up aggressive (no stabilization, up to 100 percent or 4 pods per 30s) and scale-down conservative (5 minute stabilization window, max 1 pod per minute) so the fleet does not flap during diurnal load. Workers scale independently with `replicaCount.worker`; flip `autoscaling.worker.enabled=true` to bring up a CPU-targeted worker HPA (min 1, max 8, target 75 percent, 10 minute scale-down stabilization so transient queue drains do not yank workers mid-job). The worker HPA stays CPU-only by design until a Redis queue-depth metric adapter ships; size `replicaCount.worker` for peak queue depth and let the HPA absorb the rest. Chart rendering is pinned by `tests/unit/test_helm_autoscaling.py`.

**Backup.** Postgres holds the audit log, intervention queue, policies, mutes, deliveries, experiments, and webhook subscriptions. Take logical backups with `pg_dump` against `ADHERENCE_DB_URL` on a schedule and verify restores quarterly. Model artifacts live in `ADHERENCE_MODEL_REGISTRY` (joblib + `*_index.json` pointer); snapshot the registry volume after every training run that promotes a new active version.

**Error tracking (Sentry).** Set `ADHERENCE_SENTRY_DSN` to ship unhandled errors and traces from the API and inference worker. Sample rates are tunable via `ADHERENCE_SENTRY_TRACES_SAMPLE_RATE` and `ADHERENCE_SENTRY_PROFILES_SAMPLE_RATE` (both default 0.0). The integration covers FastAPI, Starlette, SQLAlchemy, and RQ, with a `before_send` hook that scrubs `Authorization`, `X-API-Key`, and `Cookie` headers plus any `api_key` or `token` query string before events leave the process. `send_default_pii` is forced off. In Helm, populate `secrets.sentryDsn` and tune `env.ADHERENCE_SENTRY_*` per environment. Leaving the DSN empty keeps Sentry fully disabled.

**Network policy.** The Helm chart ships default-deny `NetworkPolicy` objects for the `api`, `worker`, and `trainer` deployments, gated behind `networkPolicy.enabled` (off by default for backward compatibility with clusters whose CNI does not enforce NetworkPolicy or whose dependency pod labels differ). When enabled, ingress to the api is restricted to pods matching `networkPolicy.api.fromLabels` (defaults to `ingress-nginx`), any namespaces in `networkPolicy.api.fromNamespaceLabels`, optional Prometheus scrape from `networkPolicy.prometheusNamespaceLabels`, and same-chart sidecars when `networkPolicy.api.allowSameChart=true`. Workers accept ingress only from the api component; trainers accept none. All three pods may egress to kube-dns plus the in-cluster Postgres / Redis / MLflow selectors under `networkPolicy.egress.*` and any SaaS CIDRs listed in `networkPolicy.egress.extraCIDRs` (Sentry ingest, OTLP collector, med-tracker upstream). Before enabling in a new cluster, confirm the `podLabels` in `values.yaml` match your Postgres, Redis, and MLflow installs (Bitnami charts use `app.kubernetes.io/name: postgresql` / `redis` / `mlflow`).

**On-call.** Probe liveness at `/livez`, readiness at `/readyz`, and aggregate status at `/healthz`. `/livez` always returns 200 while the event loop is responsive (process-up signal only). `/readyz` returns 200 only when the database is reachable and at least one model is loaded; it returns 503 otherwise so Kubernetes removes the pod from Service endpoints. Redis is treated as a soft dependency by default because predict and cohort routes still serve without it; set `ADHERENCE_READYZ_REQUIRE_REDIS=true` in environments where async queues are on the critical path. `/healthz` always returns 200 with a JSON `status` field of `ok` or `degraded` and is kept for dashboards that depend on the 200; do not point Kubernetes probes at it. Scrape `/metrics` for request volume, latency, queue depth, calibration drift, and rate-limit rejects. Drift alerts fire to `ADHERENCE_DRIFT_WEBHOOK_URL` when PSI crosses `ADHERENCE_DRIFT_PSI_THRESHOLD` (default 0.2). Rotate API keys via `ADHERENCE_API_KEYS` (`role:key` pairs); JWT signing key is `ADHERENCE_JWT_SECRET` (minimum 16 chars, enforced at boot). After model promotion regressions, roll back with `POST /v1/admin/models/{name}/rollback`.

**Data subject requests (GDPR).** Subject access and erasure are served at:

* `GET    /v1/users/{user_id}/data`  returns every row that references the user across `predictions`, `prediction_audit`, `dose_outcomes`, `intervention_deliveries`, `user_mutes`, `quiet_hours_policies`, `notification_budgets`, `user_risk_policies` (scope `user`), `experiment_exposures`, and `experiment_events`. Response is JSON with per-table row counts and a stable schema so snapshots can be diffed.
* `DELETE /v1/users/{user_id}/data`  hard-deletes the same set inside a single transaction and returns per-table delete counts. Idempotent: a second call returns zero. Aggregate `training_runs` rows are intentionally retained because they no longer identify the subject after row-level deletion; trigger `POST /v1/train/async` afterwards if a re-fit without the user's data is required.

Both endpoints require either the `admin` role or a DB-issued API key carrying `gdpr:read` (export) or `gdpr:erase` (delete). Every call is structured-logged with `caller`, `request_id`, and per-table counts so the access can be reconstructed from log retention. Verify the data subject's identity out-of-band before invoking these endpoints.

**Browser security headers.** Every API response carries a hardened header set from `SecurityHeadersMiddleware`: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, and a `Permissions-Policy` that disables camera, microphone, geolocation, payment, USB, magnetometer, gyroscope, and accelerometer. HSTS is opt-in: set `ADHERENCE_HSTS_ENABLED=true` in environments served over TLS (tune `ADHERENCE_HSTS_MAX_AGE_SECONDS`, `ADHERENCE_HSTS_INCLUDE_SUBDOMAINS`, `ADHERENCE_HSTS_PRELOAD`). Keep it off in local dev so plain-HTTP `curl` flows are unaffected. `ADHERENCE_CSP_POLICY` is empty by default because the API returns JSON and PNG only and the Next.js front end enforces its own CSP at the edge; set it to a full policy string to emit a global `Content-Security-Policy` header. The middleware never overwrites a header that an upstream proxy or a specific route already set, so per-response CSP overrides keep working. Disable the whole middleware with `ADHERENCE_SECURITY_HEADERS_ENABLED=false` if a fronting reverse proxy already injects the same set.

**Request body size limit.** `BodySizeLimitMiddleware` caps inbound POST/PUT/PATCH bodies and returns HTTP 413 (`{"detail": "request body too large", "limit_bytes": <int>, "received_bytes": <int>}`) above the threshold. Two enforcement paths: a fast `Content-Length` check that rejects oversize requests before the body is read, and a streaming tally that wraps the ASGI receive callable for chunked uploads where `Content-Length` is missing or untrusted. Global default is 1 MiB via `ADHERENCE_MAX_BODY_BYTES` (Helm: `env.ADHERENCE_MAX_BODY_BYTES`), which fits a several-thousand-dose schedule with headroom. Per-route overrides ship with the `with_max_body(n)` decorator from `adherence_api.body_size_middleware`; attach it above an endpoint to raise the cap on cohort bulk imports or lower it on admin write paths. Health probes (`/livez`, `/healthz`, `/readyz`), `/metrics`, and OpenAPI paths are exempt so liveness stays green even with a misconfigured tiny limit. Disable the whole middleware with `ADHERENCE_BODY_SIZE_LIMIT_ENABLED=false` if a fronting reverse proxy (nginx `client_max_body_size`, Envoy `max_request_bytes`) already enforces the cap. Rejected requests are structured-logged with path, method, observed bytes, and the configured limit, and are counted in the `adherence_api_requests_total{status="413"}` Prometheus series so a sudden spike in 413s is visible on the same dashboard as 5xx.

**Audit log tamper evidence.**Every `prediction_audit` row is chained: on insert the recorder reads the previous row's `row_hash`, stores it in `prev_hash`, then writes `row_hash = sha256(canonical_payload(row) + prev_hash)`. Hashed fields cover `id`, `request_id`, `route`, `user_id`, `caller`, `caller_role`, `model_name`, `model_version`, shadow model identifiers, dose counts, miss-probability summaries, `shadow_max_divergence`, `ok`, `error`, `response_summary`, and `created_at`. Latency is excluded so environment jitter does not invalidate the chain. Compliance jobs verify integrity with `GET /v1/audit/verify` (admin only); the response carries `n_rows`, `n_hashed`, `head_hash`, and a `breaks` list of `{row_id, reason, expected, actual}`. `reason` is `row_hash_mismatch` (a row was edited in place) or `prev_hash_mismatch` (a row was deleted or reordered). Rows written before this feature shipped have NULL `row_hash` values and are tolerated as long as the next chained row restarts with `prev_hash = NULL`; back-fill them out-of-band if a fully covered chain is required for an audit window.

**Prometheus monitoring.** The api process renders text exposition at `GET /metrics` via `adherence_common.prom` (no auth: lock down with `networkPolicy`). The Helm chart ships first-class Prometheus Operator wiring under `monitoring.*`, all disabled by default so vanilla clusters render cleanly. Enable per environment:

* `monitoring.serviceMonitor.enabled=true` installs a `ServiceMonitor` (CRD `monitoring.coreos.com/v1`) selecting the api Service on the named `http` port, scraping `/metrics` every `monitoring.serviceMonitor.interval` (30s default). Set `monitoring.serviceMonitor.additionalLabels.release=<kube-prometheus-stack release>` so the Operator's `serviceMonitorSelector` picks it up. `relabelings` and `metricRelabelings` are pass-through for custom topology labels.
* `monitoring.prometheusRule.enabled=true` installs a `PrometheusRule` with five alerts wired to real metrics emitted by `adherence_common.prom`: `AdherenceApiHighErrorRate` (5xx ratio from `adherence_api_requests_total{status=~"5.."}`), `AdherenceApiHighLatencyP95` (p95 from `adherence_api_request_duration_ms_bucket`), `AdherenceApiNoTraffic`, `AdherenceApiNoModelLoaded` (from the `adherence_model_loaded` gauge), and `AdherenceApiTargetDown`. Thresholds live in `monitoring.prometheusRule.thresholds.*` (error rate 5 percent for 10m, p95 750ms for 10m, scrape down 5m) and can be tuned without forking the template.
* `monitoring.podAnnotations.enabled=true` and `monitoring.serviceAnnotations.enabled=true` add `prometheus.io/scrape`, `prometheus.io/path=/metrics`, and `prometheus.io/port=7421` for classic kubernetes_sd scrape configs that do not use the Operator. Leave both off when the Operator is in use to avoid duplicate scrapes.

When `networkPolicy.enabled=true`, ingress from the Operator's Prometheus pods is already permitted via `networkPolicy.api.allowPrometheusScrape=true` and `networkPolicy.api.prometheusNamespaceLabels` (defaults to `name: monitoring`). Render and diff the chart with `helm template adh infra/helm/adherence-ml --set monitoring.serviceMonitor.enabled=true --set monitoring.prometheusRule.enabled=true` to inspect the manifests before applying. Chart sanity is enforced by `tests/unit/test_helm_monitoring.py`, which renders the chart with `helm template` and asserts every alert references a metric defined in `adherence_common.prom`.

**Pod and container hardening.** The Helm chart applies a Pod Security Standards "restricted" posture to every Deployment (`api`, `worker`, `trainer`) by default. Pods run as non-root uid 1001 with `fsGroup` 1001 and `seccompProfile: RuntimeDefault`; containers drop all Linux capabilities, block privilege escalation, and mount the root filesystem read-only. Scratch space for `/tmp` and framework caches is backed by `emptyDir` volumes declared in `securityContext.writableDirs` so a read-only rootfs stays usable without surrendering write access to the image layers. Defaults match what `infra/docker/Dockerfile` already prepares (uid 1001, `libgomp1` only, no shell tooling beyond what XGBoost and LightGBM need at runtime). Disable per environment with `--set securityContext.enabled=false` only if the target cluster cannot honor PSA restricted (older PSP setups requiring privileged sidecars). Tune the writable mounts via `securityContext.writableDirs[].sizeLimit` when batch trainer caches need more than the default 64 MiB. Chart rendering is pinned by `tests/unit/test_helm_security_context.py`, which asserts every rendered Deployment carries `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation=false`, dropped capabilities, and a writable `/tmp` mount.

**Supply chain security.** CI (`.github/workflows/ci.yml`, gated on repo variable `ENABLE_CI=1`) runs four security jobs in parallel with the unit tests, all required before the Docker build can run:

* `pip-audit` resolves the full uv environment and scans every installed Python dependency against the PyPI advisory database. JSON report uploaded as the `pip-audit-report` artifact (30-day retention). New CVEs surface on the run summary without blocking unrelated merges.
* `bandit` runs SAST on `packages/` and `services/` with `bandit.yaml` (excludes tests, vendored code, the web UI, and infra). Severity gate is MEDIUM (`-ll`); the build fails on any medium or high finding. Justified false positives are annotated inline with `# nosec BXXX` and a one-line reason. JSON report uploaded as `bandit-report`.
* `sbom` generates a CycloneDX 1.5 SBOM (`sbom.cdx.json`) for the resolved runtime environment via `cyclonedx-py environment`. Uploaded with 90-day retention for SOC2 evidence and downstream vuln triage.
* `trivy` rebuilds `adherence-ml:ci` and scans the image for HIGH and CRITICAL OS + library vulnerabilities, ignoring unfixed. SARIF output uploaded as `trivy-sarif` for GitHub code scanning integration.

The `docker` and `trivy` jobs depend on `pip-audit` and `bandit` passing, so a known-vulnerable build never reaches a published image. Workflow shape and bandit config are pinned by `tests/unit/test_ci_security.py`, which fails locally if a required job, gate, dependency, or artifact upload is removed. To run the same gates locally before pushing:

```
uv run bandit -c bandit.yaml -r packages services -ll
uv pip install pip-audit cyclonedx-bom
uv run pip-audit --strict
uv run cyclonedx-py environment --output-format JSON --output-file sbom.cdx.json
```

**CORS hardening.** The API mounts FastAPI `CORSMiddleware` with explicit allowlists wired to settings: `ADHERENCE_API_CORS_ORIGINS`, `ADHERENCE_API_CORS_METHODS`, `ADHERENCE_API_CORS_HEADERS`, `ADHERENCE_API_CORS_ALLOW_CREDENTIALS`, and `ADHERENCE_API_CORS_MAX_AGE_SECONDS`. List values accept comma-separated env strings (`ADHERENCE_API_CORS_ORIGINS="https://app.example.com,https://admin.example.com"`). Two boot-time guards live on the pydantic settings model. First, the combination `api_cors_origins=["*"]` plus `api_cors_allow_credentials=true` is rejected because browsers reject the response anyway per the Fetch spec and shipping that config silently breaks every credentialed XHR. Second, when `ADHERENCE_ENV=prod` the validator refuses `["*"]` for origins, methods, or headers so a misconfigured prod deploy fails to start instead of silently exposing the API to every origin. The Helm chart ships `ADHERENCE_ENV=prod` plus an explicit origin (`https://adherence.example.com`) and a curated method/header allowlist; override per environment via `--set-string env.ADHERENCE_API_CORS_ORIGINS=...`. The middleware exposes `X-Request-ID` so browser clients can correlate against server logs without an extra preflight. Dev defaults remain permissive (`*` origins, no credentials) so local `curl` and the Next.js dev server keep working. Unit coverage in `tests/unit/test_cors.py` exercises both validators and asserts the running app echoes allowed origins while ignoring disallowed ones.

**Multi-tenant scoping.** Every PII-bearing write stamps a `tenant_id` (default `"default"`) from the calling principal so audit, predictions, and intervention deliveries can be filtered without cross-tenant leakage. Tenants land on the principal three ways: DB-issued API keys carry `tenant_id` set at creation time via `POST /v1/admin/api-keys` (`{"name": ..., "role": ..., "tenant_id": "acme"}`) and surface again on `GET /v1/admin/api-keys`; JWTs minted via `POST /v1/admin/token` accept a `tenant` field that becomes the `tenant` claim and is read back on every request; legacy env-mapped keys in `ADHERENCE_API_KEYS` fall through to `ADHERENCE_DEFAULT_TENANT`. The audit reader `GET /v1/audit/list` and exporter `GET /v1/audit/export.csv` default to the caller's tenant and accept `?tenant=<id>` only when the caller is admin role; admins may pass `?tenant=*` for a cross-tenant compliance read. Non-admin callers asking for a tenant other than their own get HTTP 403 with an explicit `tenant mismatch` detail. Tenant id is included in the tamper-evident audit hash chain so swapping a row's tenant after the fact breaks `GET /v1/audit/verify`. New columns are added in place by `init_db()` via an idempotent inspector-driven `ALTER TABLE` so existing deployments converge without a separate alembic step; pre-existing rows get the `default` tenant.

## License

MIT. See `LICENSE`.

