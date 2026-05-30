"""Tests for /v1/metrics/calibration-drift."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/cd.db")
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


def test_reference_calibration_stored_at_training(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_models.registry import ModelRegistry
    items = ModelRegistry().list("default")
    assert items
    raw = items[-1].metrics.get("calibration_bins_json")
    assert raw, "training pipeline should persist calibration_bins_json"
    parsed = json.loads(raw) if isinstance(raw, str) else raw
    assert parsed["n_bins"] == 10
    assert len(parsed["bins"]) == 10
    assert sum(b["n"] for b in parsed["bins"]) == parsed["total"]


def test_calibration_drift_404_when_no_reference(tmp_path, monkeypatch):
    """If a model name has no stored reference, return a clear 404."""
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.get(
        "/v1/metrics/calibration-drift?model_name=does_not_exist",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 404
    assert "reference" in r.json()["detail"]


def test_calibration_drift_no_matched_outcomes(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.get(
        "/v1/metrics/calibration-drift?model_name=default&window_hours=24",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_matched"] == 0
    assert body["alert"] is False
    assert "no_matched_outcomes" in body["alert_reasons"]
    assert body["bins"] == []


def test_calibration_drift_admin_only(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.get(
        "/v1/metrics/calibration-drift?model_name=default",
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 403


def test_calibration_drift_alert_fires_on_skew(tmp_path, monkeypatch):
    """Inject outcomes that systematically disagree with predictions so the
    live miss-rate per bin diverges sharply from the training reference.
    """
    _setup(tmp_path, monkeypatch)
    c = _client()
    # Generate many predictions, then label them all as 'missed' regardless
    # of predicted probability. That guarantees high deltas vs. the
    # training reliability curve.
    for i in range(12):
        uid = f"u_00000{i % 3 + 1}"
        dose_ids = [f"d{i}_{j}" for j in range(4)]
        assert _predict(c, uid, dose_ids).status_code == 200
        assert _outcomes(c, uid, {d: "missed" for d in dose_ids}).status_code == 200

    r = c.get(
        "/v1/metrics/calibration-drift"
        "?model_name=default&window_hours=24"
        "&bin_alert_delta=0.2&ece_alert_delta=0.05",
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_matched"] > 0
    assert body["ece_live"] is not None
    assert body["ece_ref"] is not None
    assert body["ece_delta"] is not None
    assert body["alert"] is True
    assert body["alert_reasons"], "should report at least one alert reason"
    # Every bin row carries both sides + delta
    for b in body["bins"]:
        assert "miss_rate_live" in b and "miss_rate_ref" in b
        assert b["delta"] >= 0.0
