#!/usr/bin/env bash
# Run an end-to-end demo: train, then hit /predict with a sample schedule.
set -euo pipefail
cd "$(dirname "$0")/.."
uv run adherence-ml train --synthetic --users 1000 --days 30 --name demo --no-mlflow
cat > /tmp/schedule.json <<'JSON'
[
  {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z", "dose_class": "cardio", "dose_strength_mg": 10},
  {"dose_id": "d2", "scheduled_at": "2026-03-05T13:00:00Z", "dose_class": "psych",  "dose_strength_mg": 20},
  {"dose_id": "d3", "scheduled_at": "2026-03-05T21:30:00Z", "dose_class": "cardio", "dose_strength_mg": 50}
]
JSON
uv run adherence-ml predict u_000001 --schedule /tmp/schedule.json --model demo --top-k 3
