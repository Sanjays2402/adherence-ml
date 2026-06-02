"""Tests for /v1/cohort/risk aggregation response."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/x.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _train(name="default"):
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    return run_training(
        synthetic=True, users=80, days=10, seed=3,
        register_as=name, use_mlflow=False, cv_splits=0,
    )


def test_cohort_risk_buckets_include_n_high_risk(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.post(
        "/v1/cohort/risk",
        params={"top_users": 5},
        json={"synthetic": {"n_users": 40, "n_days": 7, "seed": 1}},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # by_tier.high (overall) must equal the sum of n_high_risk across the
    # per-class breakdown and the per-bucket breakdown (every dose lands in
    # exactly one class and exactly one bucket).
    overall_high = body["by_tier"]["high"]
    assert sum(b["n_high_risk"] for b in body["by_dose_class"]) == overall_high
    assert sum(b["n_high_risk"] for b in body["by_time_bucket"]) == overall_high

    # Per-bucket invariants: n_high_risk is bounded by n_doses and is
    # consistent with pct_high_risk (no floating-point drift beyond 1 dose).
    for bucket in (
        body["by_dose_class"]
        + body["by_time_bucket"]
        + body["top_users"]
    ):
        n = bucket["n_doses"]
        nh = bucket["n_high_risk"]
        assert 0 <= nh <= n
        assert abs(nh - round(n * bucket["pct_high_risk"])) <= 1
