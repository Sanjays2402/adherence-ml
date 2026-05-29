#!/usr/bin/env bash
# Train a baseline model on synthetic data and print the AUC.
set -euo pipefail
cd "$(dirname "$0")/.."
uv run adherence-ml generate-data --users 5000 --days 60 --out data/generated/events.parquet
uv run adherence-ml train --synthetic --users 5000 --days 60 --name default --no-mlflow
uv run adherence-ml list-models
