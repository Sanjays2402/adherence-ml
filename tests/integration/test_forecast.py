"""Tests for /v1/forecast/user N-day adherence projection."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/f.db")
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
        synthetic=True, users=120, days=14, seed=5,
        register_as=name, use_mlflow=False, cv_splits=0,
    )


def _history_for(user_id: str = "u_forecast_1"):
    """Generate two daily doses (08:00 cardio, 21:00 psych) for the last 14 days."""
    out = []
    now = datetime(2026, 5, 20, 0, 0, tzinfo=timezone.utc)
    for d in range(14):
        day = now - timedelta(days=14 - d)
        out.append({
            "user_id": user_id,
            "dose_id": f"h{d}a",
            "scheduled_at": day.replace(hour=8).isoformat(),
            "taken_at": day.replace(hour=8, minute=5).isoformat(),
            "status": "taken",
            "dose_class": "cardio",
            "dose_strength_mg": 10.0,
        })
        out.append({
            "user_id": user_id,
            "dose_id": f"h{d}b",
            "scheduled_at": day.replace(hour=21).isoformat(),
            "taken_at": None,
            "status": "missed",
            "dose_class": "psych",
            "dose_strength_mg": 5.0,
        })
    return out


def test_forecast_with_derived_schedule(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {
        "user_id": "u_forecast_1",
        "history": _history_for(),
        "horizon_days": 7,
        "starting_at": "2026-05-20T00:00:00+00:00",
        "bootstrap_iterations": 100,
    }
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["schedule_source"] == "derived"
    assert body["horizon_days"] == 7
    # 2 doses/day x 7 days = 14
    assert body["n_doses_scored"] == 14
    assert len(body["by_day"]) == 7
    total_high = 0
    total_medium = 0
    total_expected = 0.0
    for day in body["by_day"]:
        assert day["n_doses"] == 2
        assert 0.0 <= day["mean_miss_probability"] <= 1.0
        assert abs(day["projected_adherence_rate"] + day["mean_miss_probability"] - 1.0) < 1e-9
        # expected_misses is sum of probs; n_doses * mean = sum.
        assert abs(day["expected_misses"] - day["n_doses"] * day["mean_miss_probability"]) < 1e-9
        assert day["high_risk_count"] >= 0
        assert day["medium_risk_count"] >= 0
        assert day["high_risk_count"] + day["medium_risk_count"] <= day["n_doses"]
        total_high += day["high_risk_count"]
        total_medium += day["medium_risk_count"]
        total_expected += day["expected_misses"]
    assert body["total_high_risk_count"] == total_high
    assert body["total_medium_risk_count"] == total_medium
    assert abs(body["total_expected_misses"] - total_expected) < 1e-6
    # worst_day should point at the by_day row with the largest expected_misses,
    # ties broken by earliest date.
    max_em = max(d["expected_misses"] for d in body["by_day"])
    expected_worst = next(d["date"] for d in body["by_day"] if d["expected_misses"] == max_em)
    assert body["worst_day"] == expected_worst
    assert abs(body["worst_day_expected_misses"] - max_em) < 1e-9
    rate = body["overall_projected_adherence_rate"]
    assert 0.0 <= rate <= 1.0
    assert body["overall_adherence_ci_low"] <= rate <= body["overall_adherence_ci_high"]


def test_forecast_with_supplied_schedule(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    schedule = [
        {"dose_id": "d1", "scheduled_at": "2026-05-21T08:00:00+00:00",
         "dose_class": "cardio", "dose_strength_mg": 10.0},
        {"dose_id": "d2", "scheduled_at": "2026-05-22T08:00:00+00:00",
         "dose_class": "cardio", "dose_strength_mg": 10.0},
    ]
    r = c.post(
        "/v1/forecast/user",
        json={
            "user_id": "u_forecast_2",
            "history": _history_for("u_forecast_2"),
            "schedule": schedule,
            "horizon_days": 2,
            "bootstrap_iterations": 50,
        },
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["schedule_source"] == "supplied"
    assert body["n_doses_scored"] == 2
    assert len(body["by_day"]) == 2


def test_forecast_rejects_when_no_schedule_derivable(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/forecast/user",
        json={"user_id": "u_empty", "history": [], "horizon_days": 3},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 400
    assert "schedule" in r.json()["detail"].lower()


def test_forecast_requires_service_role(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/forecast/user",
        json={"user_id": "u1", "history": _history_for("u1"), "horizon_days": 3},
        headers={"x-api-key": "vwr"},
    )
    assert r.status_code == 403


def test_forecast_bootstrap_zero_collapses_to_point(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.post(
        "/v1/forecast/user",
        json={
            "user_id": "u_pt",
            "history": _history_for("u_pt"),
            "horizon_days": 2,
            "bootstrap_iterations": 0,
        },
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200
    body = r.json()
    assert abs(body["overall_adherence_ci_low"] - body["overall_projected_adherence_rate"]) < 1e-9
    assert abs(body["overall_adherence_ci_high"] - body["overall_projected_adherence_rate"]) < 1e-9
