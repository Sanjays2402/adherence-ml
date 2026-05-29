# adherence-ml

A Python service that predicts which medication doses a user is likely to miss in the next 24 hours. Built around an XGBoost + LightGBM ensemble with SHAP-derived per-dose reason codes, drift monitoring, calibration plots, and a small REST surface intended to plug into [Med-Tracker](https://github.com/Sanjays2402) or any similar adherence app.

## Quickstart

```bash
git clone https://github.com/Sanjays2402/adherence-ml
cd adherence-ml
uv sync
cp .env.example .env

# Train a tiny model (synthetic 200 users x 14 days)
uv run python -c "from adherence_trainer.pipeline import run_training; \
  print(run_training(synthetic=True, users=200, days=14, register_as='default', use_mlflow=False)['metrics'])"

# Start the API
uv run uvicorn adherence_api.app:create_app --factory --reload --port 8000
```

Make a prediction:

```bash
curl -s -X POST http://localhost:8000/v1/predict \
  -H "x-api-key: $(grep ADHERENCE_API_KEYS .env | head -1 | sed 's/.*service://;s/,.*//')" \
  -H "content-type: application/json" \
  -d '{
    "user_id": "u_000001",
    "schedule": [
      {"dose_id":"d1","scheduled_at":"2026-06-01T08:00:00Z","dose_class":"cardio","dose_strength_mg":10},
      {"dose_id":"d2","scheduled_at":"2026-06-01T21:30:00Z","dose_class":"psych","dose_strength_mg":5}
    ],
    "top_k_reasons": 3
  }' | jq .
```

Response includes `miss_probability`, `risk_tier` (low/medium/high), and human-readable `reasons` per dose. See [docs/openapi.json](docs/openapi.json) for the full spec.

## What's in the box

| Path | Purpose |
| --- | --- |
| `packages/data` | Synthetic event generator (7 personas, configurable users x days) and a stub Med-Tracker client |
| `packages/features` | Causal feature engineering (time-of-day cyclical encoding, streaks, recent miss/late rates, dose-class one-hot), PSI-based drift detector |
| `packages/models` | XGBoost + LightGBM ensemble with isotonic calibration and a filesystem model registry |
| `packages/explain` | SHAP wrapper, human reason-code templates, calibration and importance plots |
| `packages/common` | Shared pydantic schemas, settings, structlog config, auth (API key + JWT), telemetry |
| `services/api` | FastAPI app: `/predict`, `/train`, `/explain`, `/cohort`, `/drift`, `/plots`, `/healthz`, `/admin` |
| `services/trainer` | Training pipeline with MLflow tracking and time-series CV |
| `services/inference_worker` | Async batch inference + Redis queue consumer |
| `services/cli` | `adherence` CLI for offline scoring and admin tasks |
| `infra` | Multi-stage Dockerfiles, docker-compose dev stack, Helm chart, Terraform (ECS + RDS + S3) |
| `clients` | TypeScript and Python client libraries for downstream consumers |

## REST API

| Method | Path | Role required | Notes |
| --- | --- | --- | --- |
| GET  | `/healthz`, `/livez` | none | redis + db + model checks |
| POST | `/v1/predict` | service | per-dose miss probability + reasons |
| POST | `/v1/predict/batch` | service | score many users in one call (Med-Tracker nightly cron) |
| POST | `/v1/train`, `/v1/train/async` | admin | retrain on synthetic or supplied events |
| GET  | `/v1/explain/global` | viewer | gain + mean \|SHAP\| per feature, ranked |
| GET  | `/v1/explain/sample` | viewer | raw SHAP for N synthetic doses |
| POST | `/v1/cohort/risk` | service | aggregate risk by dose-class, time bucket, user |
| POST | `/v1/drift/check` | service | PSI vs the training reference distribution |
| GET  | `/v1/plots/calibration.png` | viewer | reliability diagram PNG |
| GET  | `/v1/plots/importance.png` | viewer | feature importance PNG |
| POST | `/v1/admin/token` | admin | mint short-lived JWT for service callers |
| GET  | `/v1/admin/models` | admin | list registered models |
| POST | `/v1/webhooks/medtracker/event` | service | inbound event ingest |

Auth is `x-api-key: <key>` or `Authorization: Bearer <jwt>`. Configure keys via `ADHERENCE_API_KEYS=admin:...,service:...,viewer:...`.

## Plugging into Med-Tracker

The intended pattern: Med-Tracker pushes dose events as they happen (webhook), and asks adherence-ml for tomorrow's miss probabilities once per day per user (or on demand before sending a reminder).

TypeScript:

```ts
import { AdherenceClient } from "@medtracker/adherence-client";

const client = new AdherenceClient({
  baseUrl: process.env.ADHERENCE_URL!,
  apiKey: process.env.ADHERENCE_SERVICE_KEY!,
});

const { predictions } = await client.predict({
  user_id: user.id,
  schedule: tomorrowSchedule,
  history: last30Days,
  top_k_reasons: 3,
});

for (const p of predictions) {
  if (p.risk_tier === "high") sendExtraReminder(p.dose_id, p.reasons);
}
```

Python:

```python
from adherence_client import AdherenceClient
client = AdherenceClient(base_url="http://adherence-ml:8000", api_key=os.environ["KEY"])
res = client.predict(user_id="u_42", schedule=schedule, history=history)
```

Regenerate a fully typed TS client any time:

```bash
uv run python scripts/export_openapi.py > docs/openapi.json
npx openapi-typescript docs/openapi.json -o clients/typescript/adherence.types.ts
```

## Model

* Ensemble: weighted average of an XGBoost classifier and a LightGBM classifier, isotonically calibrated on a held-out fold.
* Target: `missed_or_skipped` within a configurable late-window (default 30 min after `scheduled_at`).
* Features (20): cyclical hour/day encodings, weekend flag, time bucket, dose class index, dose strength, taken/missed streaks, 24h and 7d rolling miss rates, 7d late rate, doses-today-so-far, time since last scheduled/taken dose, sleep-window proxy, per-user class diversity and history length.
* Evaluation: time-series CV with AUC, PR-AUC, Brier, ECE, and per-tier precision/recall. See [docs/architecture.md](docs/architecture.md).
* Tracking: MLflow (file backend by default; point `ADHERENCE_MLFLOW_TRACKING_URI` at a server to centralize).

## Synthetic data

`packages/data` ships a generator with 7 personas (consistent taker, weekend-skipper, night-shift, polypharm-elder, antibiotic-completer, supplement-drifter, chaotic). Useful for bootstrapping a model before real data arrives, for CI tests, and for property-based fuzzing (`tests/property/`).

```python
from adherence_data import SyntheticConfig, generate_events
events = generate_events(SyntheticConfig(n_users=5000, n_days=60, seed=42))
```

## Tests

```bash
uv run pytest -q              # 24 tests: unit + property + integration
uv run pytest --cov=packages --cov=services
```

## Operations

* `infra/docker/docker-compose.dev.yml` brings up Postgres, Redis, MLflow, the API, and a worker.
* `infra/helm/adherence-ml` is a real chart (deployment, HPA, PDB, ingress, ServiceAccount, ConfigMap) for Kubernetes.
* `infra/terraform/` provisions ECS + RDS + S3 for the model registry on AWS.
* `.github/workflows/` are gated on the `ENABLE_CI` repo variable so the workflows don't burn Actions minutes until you opt in.

## Configuration

All settings come from env vars prefixed `ADHERENCE_` (see `.env.example`). Notable ones:

| Var | Default | Purpose |
| --- | --- | --- |
| `ADHERENCE_API_KEYS` | unset | `admin:...,service:...,viewer:...` mapping |
| `ADHERENCE_JWT_SECRET` | unset (required) | HMAC key for minted tokens |
| `ADHERENCE_MODEL_REGISTRY` | `./models` | filesystem path or `s3://bucket/prefix` |
| `ADHERENCE_DB_URL` | `sqlite:///adherence.db` | event store |
| `ADHERENCE_REDIS_URL` | unset | enables the async inference queue |
| `ADHERENCE_MLFLOW_TRACKING_URI` | `file:./mlruns` | MLflow backend |

## License

MIT, see [LICENSE](LICENSE).
