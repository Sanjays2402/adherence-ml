"""Integration tests for /v1/interventions."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/iv.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=13,
                 register_as="default", use_mlflow=False, cv_splits=0)


def test_interventions_endpoint_returns_actions(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    payload = {
        "user_id": "u_000001",
        "schedule": [
            {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
            {"dose_id": "d2", "scheduled_at": "2026-03-05T21:30:00Z",
             "dose_class": "psych", "dose_strength_mg": 5.0},
        ],
        "top_k_reasons": 3,
    }
    r = client.post("/v1/interventions", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user_id"] == "u_000001"
    assert len(body["predictions"]) == 2
    # interventions may be empty if both doses are low risk; structure must hold
    assert isinstance(body["interventions"], list)
    assert "summary" in body
    assert body["summary"]["n_actions"] == len(body["interventions"])


def test_from_predictions_pure_function_endpoint(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    body = {
        "user_id": "u",
        "model_version": "v-x",
        "predictions": [
            {"dose_id": "d1", "miss_probability": 0.9, "risk_tier": "high",
             "dose_class": "antibiotic",
             "reasons": [{"feature": "refill_gap", "contribution": 0.3, "human": "low supply"}]},
        ],
    }
    r = client.post("/v1/interventions/from-predictions", json=body,
                    headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    js = r.json()
    actions = [iv["action"] for iv in js["interventions"]]
    assert "push_reminder" in actions
    assert "refill_nudge" in actions
    assert "telehealth_followup" in actions
    # scores sorted desc
    scores = [iv["score"] for iv in js["interventions"]]
    assert scores == sorted(scores, reverse=True)


def test_interventions_requires_service_role(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.post("/v1/interventions", json={"user_id": "u", "schedule": []})
    assert r.status_code == 401
    r = client.post("/v1/interventions",
                    json={"user_id": "u", "schedule": []},
                    headers={"x-api-key": "vwr"})
    assert r.status_code == 403
