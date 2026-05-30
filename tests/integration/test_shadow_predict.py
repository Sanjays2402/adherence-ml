"""Integration tests for shadow model A/B scoring on /v1/predict."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/shadow.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod, db as db_mod
    audit_mod._INITIALIZED = False
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    # primary
    run_training(synthetic=True, users=80, days=10, seed=11,
                 register_as="default", use_mlflow=False, cv_splits=0)
    # challenger: different seed produces a measurably different model
    run_training(synthetic=True, users=80, days=10, seed=99,
                 register_as="challenger", use_mlflow=False, cv_splits=0)


def _payload():
    return {
        "user_id": "u_000001",
        "schedule": [
            {"dose_id": f"d{i}", "scheduled_at": f"2026-03-05T0{i + 1}:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0}
            for i in range(3)
        ],
        "top_k_reasons": 2,
    }


def test_predict_with_shadow_returns_primary_response(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.post("/v1/predict?model_name=default&shadow=challenger",
                    json=_payload(), headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    # Response itself still uses primary; challenger only feeds the audit log.
    body = r.json()
    assert body["predictions"]


def test_shadow_writes_divergence_to_audit(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.post("/v1/predict?model_name=default&shadow=challenger",
                    json=_payload(), headers={"x-api-key": "svc"})
    assert r.status_code == 200

    r = client.get("/v1/audit/list?limit=5", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    # latest row should carry shadow info; AuditRow doesn't expose shadow_*,
    # so use /shadow stats instead.
    r = client.get("/v1/audit/shadow?window_hours=1", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["n_with_shadow"] >= 1
    rows = {row["shadow_model_name"]: row for row in s["rows"]}
    assert "challenger" in rows
    row = rows["challenger"]
    assert row["n_calls"] >= 1
    assert row["max_divergence"] >= 0.0
    assert row["mean_divergence"] >= 0.0
    assert row["p95_divergence"] >= 0.0


def test_shadow_same_as_primary_is_noop(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.post("/v1/predict?model_name=default&shadow=default",
                    json=_payload(), headers={"x-api-key": "svc"})
    assert r.status_code == 200
    r = client.get("/v1/audit/shadow", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    assert r.json()["n_with_shadow"] == 0


def test_missing_shadow_model_does_not_break_primary(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.post("/v1/predict?model_name=default&shadow=does_not_exist",
                    json=_payload(), headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["predictions"]
    # admin /shadow rolls up by name; failed shadow logs version="error:..."
    # but divergence is None so it won't appear in /shadow stats.


def test_shadow_endpoint_requires_admin(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.get("/v1/audit/shadow", headers={"x-api-key": "svc"})
    assert r.status_code == 403
    r = client.get("/v1/audit/shadow", headers={"x-api-key": "vwr"})
    assert r.status_code == 403
