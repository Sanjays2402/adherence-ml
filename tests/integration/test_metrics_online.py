"""Integration tests for /v1/metrics/online (audit + outcomes join)."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/om.db")
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
    run_training(synthetic=True, users=60, days=10, seed=7,
                 register_as="default", use_mlflow=False, cv_splits=0)


def _client():
    from adherence_api.app import create_app
    return TestClient(create_app())


def _predict(c, user_id, dose_ids):
    return c.post(
        "/v1/predict",
        json={
            "user_id": user_id,
            "schedule": [
                {"dose_id": d, "scheduled_at": "2026-03-05T08:00:00Z",
                 "dose_class": "cardio", "dose_strength_mg": 10.0}
                for d in dose_ids
            ],
            "top_k_reasons": 0,
        },
        headers={"x-api-key": "svc"},
    )


def _outcomes(c, user_id, mapping):
    """mapping: {dose_id: 'taken'|'missed'|'late'}"""
    events = [
        {
            "event_id": f"{user_id}-{d}",
            "user_id": user_id,
            "dose_id": d,
            "scheduled_at": "2026-03-05T08:00:00Z",
            "observed_at": "2026-03-05T08:05:00Z",
            "outcome": o,
        }
        for d, o in mapping.items()
    ]
    return c.post("/v1/webhooks/medtracker/event",
                  json={"events": events}, headers={"x-api-key": "svc"})


def test_online_metrics_empty_when_no_outcomes(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    assert _predict(c, "u_000001", ["d1", "d2"]).status_code == 200
    r = c.get("/v1/metrics/online?window_hours=24",
              headers={"x-api-key": "adm"})
    assert r.status_code == 200
    body = r.json()
    assert body["n_matched"] == 0
    assert body["auc"] is None
    assert body["calibration"] == []


def test_online_metrics_joins_predictions_to_outcomes(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    # Generate predictions + outcomes for several users so AUC is defined.
    for i in range(8):
        uid = f"u_00000{i % 3 + 1}"
        dose_ids = [f"d{i}_{j}" for j in range(4)]
        assert _predict(c, uid, dose_ids).status_code == 200
        # Mix taken/missed/late so we have both classes.
        outcomes = {
            dose_ids[0]: "missed",
            dose_ids[1]: "taken",
            dose_ids[2]: "late",
            dose_ids[3]: "missed" if i % 2 == 0 else "taken",
        }
        assert _outcomes(c, uid, outcomes).status_code == 200

    r = c.get("/v1/metrics/online?window_hours=24&n_bins=5",
              headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_matched"] > 0
    assert body["n_predictions"] > 0
    assert body["n_positives"] > 0
    assert 0.0 <= body["base_rate"] <= 1.0
    assert body["brier"] is not None and 0.0 <= body["brier"] <= 1.0
    assert body["log_loss"] is not None and body["log_loss"] > 0
    assert body["ece"] is not None and 0.0 <= body["ece"] <= 1.0
    assert len(body["calibration"]) == 5
    assert "default" in body["by_model"]
    assert body["by_model"]["default"]["n"] == body["n_matched"]


def test_online_metrics_late_treated_as_taken(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    assert _predict(c, "u_000001", ["a", "b"]).status_code == 200
    assert _outcomes(c, "u_000001",
                     {"a": "late", "b": "late"}).status_code == 200
    r = c.get("/v1/metrics/online?window_hours=24",
              headers={"x-api-key": "adm"})
    body = r.json()
    assert body["n_matched"] == 2
    assert body["n_positives"] == 0  # late counted as delivered
    assert body["auc"] is None  # only one class -> undefined


def test_online_metrics_admin_only(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.get("/v1/metrics/online", headers={"x-api-key": "svc"})
    assert r.status_code == 403
