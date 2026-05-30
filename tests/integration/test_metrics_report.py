"""Tests for /v1/metrics/online/report (cohort-sliced eval report)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/orpt.db")
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
    run_training(synthetic=True, users=60, days=10, seed=11,
                 register_as="default", use_mlflow=False, cv_splits=0)


def _client():
    from adherence_api.app import create_app
    return TestClient(create_app())


def _predict_mixed(c, user_id, items):
    """items: list of (dose_id, dose_class, hour)."""
    sched = [
        {"dose_id": d, "scheduled_at": f"2026-03-05T{h:02d}:00:00Z",
         "dose_class": cls, "dose_strength_mg": 5.0}
        for (d, cls, h) in items
    ]
    return c.post("/v1/predict", json={"user_id": user_id, "schedule": sched,
                                       "top_k_reasons": 0},
                  headers={"x-api-key": "svc"})


def _outcomes(c, user_id, mapping_with_hour):
    """mapping_with_hour: dict[dose_id, (outcome, hour)]"""
    events = [
        {
            "event_id": f"{user_id}-{d}",
            "user_id": user_id, "dose_id": d,
            "scheduled_at": f"2026-03-05T{h:02d}:00:00Z",
            "observed_at": f"2026-03-05T{h:02d}:05:00Z",
            "outcome": o,
        }
        for d, (o, h) in mapping_with_hour.items()
    ]
    return c.post("/v1/webhooks/medtracker/event",
                  json={"events": events}, headers={"x-api-key": "svc"})


def test_report_empty_payload(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.get("/v1/metrics/online/report?window_hours=24",
              headers={"x-api-key": "adm"})
    assert r.status_code == 200
    body = r.json()
    assert body["n_matched"] == 0
    assert body["confusion"] is None
    assert body["lift_curve"] == []
    assert body["by_dose_class"] == []


def test_report_lift_confusion_cohorts(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    # Two classes, four hours-of-day. Generate predictions and outcomes.
    items_u1 = [
        ("d1", "cardio", 5),   # 00-06
        ("d2", "cardio", 8),   # 06-12
        ("d3", "psych",  14),  # 12-18
        ("d4", "psych",  21),  # 18-24
    ]
    items_u2 = [
        ("d5", "cardio", 4),
        ("d6", "psych",  10),
        ("d7", "cardio", 16),
        ("d8", "psych",  22),
    ]
    assert _predict_mixed(c, "u_r1", items_u1).status_code == 200
    assert _predict_mixed(c, "u_r2", items_u2).status_code == 200

    assert _outcomes(c, "u_r1", {
        "d1": ("missed", 5), "d2": ("taken", 8),
        "d3": ("missed", 14), "d4": ("taken", 21),
    }).status_code == 200
    assert _outcomes(c, "u_r2", {
        "d5": ("missed", 4), "d6": ("taken", 10),
        "d7": ("taken", 16), "d8": ("missed", 22),
    }).status_code == 200

    r = c.get("/v1/metrics/online/report?window_hours=24&threshold=0.3",
              headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_matched"] == 8
    assert body["n_positives"] == 4
    assert 0.0 <= body["base_rate"] <= 1.0

    # confusion matrix counts add up
    cm = body["confusion"]
    assert cm["tp"] + cm["fp"] + cm["tn"] + cm["fn"] == 8
    assert cm["threshold"] == 0.3

    # lift curve sorted by k_pct, values bounded
    lift = body["lift_curve"]
    assert lift and [r["k_pct"] for r in lift] == sorted(r["k_pct"] for r in lift)
    for row in lift:
        assert 0.0 <= row["recall"] <= 1.0
        assert 0.0 <= row["precision"] <= 1.0
        assert row["lift"] >= 0.0

    # cohort slices: both classes present
    classes = {row["cohort"] for row in body["by_dose_class"]}
    assert classes == {"cardio", "psych"}
    for row in body["by_dose_class"]:
        assert row["n"] >= 1
        assert row["n_positives"] <= row["n"]
        assert 0.0 <= row["base_rate"] <= 1.0

    # hour-bucket slices: at least 3 of 4 buckets seen
    buckets = {row["cohort"] for row in body["by_hour_bucket"]}
    assert buckets.issubset({"00-06", "06-12", "12-18", "18-24"})
    assert len(buckets) >= 3


def test_report_requires_admin(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.get("/v1/metrics/online/report", headers={"x-api-key": "svc"})
    assert r.status_code == 403
