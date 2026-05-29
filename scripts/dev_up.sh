#!/usr/bin/env bash
# Boot the full dev stack (postgres + redis + mlflow + api + worker + trainer).
set -euo pipefail
cd "$(dirname "$0")/../infra/docker"
docker compose -f docker-compose.dev.yml up --build "$@"
