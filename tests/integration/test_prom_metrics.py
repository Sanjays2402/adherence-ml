"""Integration tests for the Prometheus /metrics endpoint."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/m.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod, db as db_mod
    audit_mod._INITIALIZED = False
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    # Reset metric state so per-test counts are deterministic.
    from adherence_common import prom
    for collector in prom.REGISTRY._collectors:
        if hasattr(collector, "_vals"):
            collector._vals.clear()
        if hasattr(collector, "_counts"):
            collector._counts.clear()
            collector._sum.clear()
            collector._n.clear()
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=60, days=10, seed=3,
                 register_as="default", use_mlflow=False, cv_splits=0)


def _client():
    from adherence_api.app import create_app
    return TestClient(create_app())


def test_metrics_endpoint_serves_text_exposition(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.get("/metrics")
    assert r.status_code == 200
    body = r.text
    assert "# TYPE adherence_api_requests_total counter" in body
    assert "# TYPE adherence_api_request_duration_ms histogram" in body
    assert "adherence_model_loaded{model=\"default\"} 1.0" in body


def test_metrics_counts_requests_and_predictions(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    payload = {
        "user_id": "u_000001",
        "schedule": [
            {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
            {"dose_id": "d2", "scheduled_at": "2026-03-05T09:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
        ],
        "top_k_reasons": 0,
    }
    for _ in range(3):
        assert c.post("/v1/predict", json=payload,
                      headers={"x-api-key": "svc"}).status_code == 200
    body = c.get("/metrics").text
    # 3 predict calls -> 3 successful requests on that route template.
    assert (
        'adherence_api_requests_total{method="POST",'
        'route="/v1/predict",status="200"} 3'
    ) in body
    # Latency histogram observed 3 times on the same route.
    assert (
        'adherence_api_request_duration_ms_count{method="POST",'
        'route="/v1/predict"} 3'
    ) in body
    # 3 calls x 2 doses = 6 predictions across tier labels.
    pred_lines = [
        ln for ln in body.splitlines()
        if ln.startswith("adherence_predictions_total{")
    ]
    total = sum(float(ln.split()[-1]) for ln in pred_lines)
    assert total == 6.0


def test_metrics_records_shadow_divergence(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=60, days=10, seed=999,
                 register_as="challenger", use_mlflow=False, cv_splits=0)
    c = _client()
    payload = {
        "user_id": "u_000001",
        "schedule": [
            {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
        ],
        "top_k_reasons": 0,
    }
    r = c.post("/v1/predict?shadow=challenger", json=payload,
               headers={"x-api-key": "svc"})
    assert r.status_code == 200
    body = c.get("/metrics").text
    assert (
        'adherence_shadow_divergence_count{shadow_model="challenger"} 1'
    ) in body
