"""End-to-end: train tiny model, predict, check API surface logic."""
import json

import pandas as pd
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    reload_settings()


def test_train_then_predict_e2e(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    # Clear LRU model cache
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()

    from adherence_trainer.pipeline import run_training
    res = run_training(synthetic=True, users=120, days=14, seed=5,
                       register_as="default", use_mlflow=False, cv_splits=0)
    assert res["metrics"]["auc"] > 0.55

    from adherence_api.app import create_app
    app = create_app()
    client = TestClient(app)

    # health
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["model_loaded"]

    # predict requires service+
    schedule = [
        {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z", "dose_class": "cardio", "dose_strength_mg": 10.0},
        {"dose_id": "d2", "scheduled_at": "2026-03-05T21:30:00Z", "dose_class": "psych", "dose_strength_mg": 5.0},
    ]
    payload = {"user_id": "u_000001", "schedule": schedule, "top_k_reasons": 3}

    r = client.post("/v1/predict", json=payload)
    assert r.status_code == 401

    r = client.post("/v1/predict", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data["predictions"]) == 2
    for p in data["predictions"]:
        assert 0.0 <= p["miss_probability"] <= 1.0
        assert p["risk_tier"] in {"low", "medium", "high"}
        assert len(p["reasons"]) >= 1


def test_admin_can_mint_token(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.post("/v1/admin/token", json={"subject": "bob", "role": "service"},
                    headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    # use that JWT to call predict
    r = client.post(
        "/v1/predict",
        json={"user_id": "u", "schedule": [], "top_k_reasons": 1},
        headers={"authorization": f"Bearer {tok}"},
    )
    # 200 with empty predictions OR 503 if no model loaded
    assert r.status_code in (200, 503)
