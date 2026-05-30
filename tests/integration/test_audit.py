"""Integration tests for prediction audit log + /v1/audit endpoints."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/audit.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    # disable rate limiter so a tight test loop doesn't get throttled
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    # reset audit init flag so it picks up the new DB
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False


def _train(tmp_path):
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=11,
                 register_as="default", use_mlflow=False, cv_splits=0)


def test_predict_writes_audit_row(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    schedule = [
        {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
         "dose_class": "cardio", "dose_strength_mg": 10.0},
    ]
    payload = {"user_id": "u_000007", "schedule": schedule, "top_k_reasons": 2}
    r = client.post("/v1/predict", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200

    # admin can list it back
    r = client.get("/v1/audit/list?limit=10", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n"] >= 1
    row = next(x for x in body["items"] if x["user_id"] == "u_000007")
    assert row["route"] == "/v1/predict"
    assert row["ok"] is True
    assert row["n_doses"] == 1
    assert row["model_version"]
    assert row["latency_ms"] is not None and row["latency_ms"] >= 0
    assert row["caller_role"] == "service"
    assert row["caller"].startswith("k:")


def test_audit_filters_by_user_and_only_errors(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    for uid in ["alice", "bob", "alice"]:
        client.post("/v1/predict",
                    json={"user_id": uid, "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "svc"})

    r = client.get("/v1/audit/list?user_id=alice", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    rows = r.json()["items"]
    assert rows and all(x["user_id"] == "alice" for x in rows)

    # errors filter on a clean run should return empty
    r = client.get("/v1/audit/list?only_errors=true", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_audit_stats_aggregates(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    base = {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0}
    for i in range(4):
        client.post("/v1/predict",
                    json={"user_id": f"u_{i}", "schedule": [base], "top_k_reasons": 1},
                    headers={"x-api-key": "svc"})

    r = client.get("/v1/audit/stats?window_hours=1", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["n_calls"] >= 4
    assert s["error_rate"] == 0.0
    assert s["p50_latency_ms"] is not None
    assert s["p95_latency_ms"] is not None
    assert s["by_route"].get("/v1/predict", 0) >= 4
    assert "default" in s["by_model"]


def test_audit_endpoints_require_admin(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    r = client.get("/v1/audit/list", headers={"x-api-key": "svc"})
    assert r.status_code == 403
    r = client.get("/v1/audit/stats", headers={"x-api-key": "vwr"})
    assert r.status_code == 403


def test_batch_predict_writes_per_item_audit(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    _train(tmp_path)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    item = {
        "user_id": "u_batch",
        "schedule": [{
            "dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
            "dose_class": "cardio", "dose_strength_mg": 10.0,
        }],
        "top_k_reasons": 1,
    }
    r = client.post("/v1/predict/batch",
                    json={"items": [item, item, item]},
                    headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text

    r = client.get("/v1/audit/list?route=/v1/predict/batch&user_id=u_batch",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    rows = r.json()["items"]
    assert len(rows) >= 3
