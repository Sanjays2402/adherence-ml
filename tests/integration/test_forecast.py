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
    # n_high_risk_days / n_medium_risk_days count the by_day rows whose
    # high_risk_count / medium_risk_count are > 0 (days, not doses) so
    # outreach planners can render '3 of the next 7 days have a high-risk
    # dose' without iterating by_day client-side.
    expected_n_high_days = sum(1 for d in body["by_day"] if d["high_risk_count"] > 0)
    expected_n_medium_days = sum(1 for d in body["by_day"] if d["medium_risk_count"] > 0)
    assert body["n_high_risk_days"] == expected_n_high_days
    assert body["n_medium_risk_days"] == expected_n_medium_days
    assert 0 <= body["n_high_risk_days"] <= len(body["by_day"])
    assert 0 <= body["n_medium_risk_days"] <= len(body["by_day"])
    assert abs(body["total_expected_misses"] - total_expected) < 1e-6
    # worst_day should point at the by_day row with the largest expected_misses,
    # ties broken by earliest date.
    max_em = max(d["expected_misses"] for d in body["by_day"])
    expected_worst = next(d["date"] for d in body["by_day"] if d["expected_misses"] == max_em)
    assert body["worst_day"] == expected_worst
    assert abs(body["worst_day_expected_misses"] - max_em) < 1e-9
    worst_row = next(d for d in body["by_day"] if d["date"] == expected_worst)
    assert body["worst_day_n_doses"] == worst_row["n_doses"]
    assert abs(body["worst_day_projected_adherence_rate"] - worst_row["projected_adherence_rate"]) < 1e-9
    assert body["worst_day_high_risk_count"] == worst_row["high_risk_count"]
    assert body["worst_day_medium_risk_count"] == worst_row["medium_risk_count"]
    # worst_day_days_out is zero-based offset from the earliest by_day row (the
    # same calendar day as the default starting_at=now), symmetric with
    # first_high_risk_day_days_out.
    from datetime import date as _date_wd
    earliest_date_wd = body["by_day"][0]["date"]
    expected_worst_days_out = (
        _date_wd.fromisoformat(expected_worst) - _date_wd.fromisoformat(earliest_date_wd)
    ).days
    assert body["worst_day_days_out"] == expected_worst_days_out
    assert body["worst_day_days_out"] >= 0
    # first_high_risk_day is the earliest by_day with high_risk_count > 0,
    # or null when no horizon day has any high-risk dose.
    expected_first_high = next(
        (d["date"] for d in body["by_day"] if d["high_risk_count"] > 0),
        None,
    )
    assert body["first_high_risk_day"] == expected_first_high
    if expected_first_high is None:
        assert body["first_high_risk_day_high_risk_count"] == 0
        assert body["first_high_risk_day_medium_risk_count"] == 0
        assert body["first_high_risk_day_n_doses"] == 0
        assert body["first_high_risk_day_projected_adherence_rate"] == 0.0
        assert body["first_high_risk_day_expected_misses"] == 0.0
        assert body["first_high_risk_day_days_out"] == -1
    else:
        first_row = next(d for d in body["by_day"] if d["date"] == expected_first_high)
        assert body["first_high_risk_day_high_risk_count"] == first_row["high_risk_count"]
        assert body["first_high_risk_day_medium_risk_count"] == first_row["medium_risk_count"]
        assert body["first_high_risk_day_n_doses"] == first_row["n_doses"]
        assert abs(body["first_high_risk_day_projected_adherence_rate"] - first_row["projected_adherence_rate"]) < 1e-9
        assert abs(body["first_high_risk_day_expected_misses"] - first_row["expected_misses"]) < 1e-9
        # days_out is zero-based offset from the earliest by_day row (which is
        # the same calendar day as the default starting_at=now).
        earliest_date = body["by_day"][0]["date"]
        from datetime import date as _date
        expected_days_out = (
            _date.fromisoformat(expected_first_high) - _date.fromisoformat(earliest_date)
        ).days
        assert body["first_high_risk_day_days_out"] == expected_days_out
        assert body["first_high_risk_day_days_out"] >= 0
    rate = body["overall_projected_adherence_rate"]
    assert 0.0 <= rate <= 1.0
    assert body["overall_adherence_ci_low"] <= rate <= body["overall_adherence_ci_high"]
    # next_dose pointer set: earliest scheduled dose in the horizon, with
    # its miss_probability and risk_tier surfaced inline for the outreach UI.
    sched_times = []
    for day in body["by_day"]:
        # day has aggregates only; next_dose comes from the actual scored doses.
        pass
    assert body["next_dose_id"] is not None
    assert body["next_dose_scheduled_at"] is not None
    # The earliest scheduled dose for the derived schedule starting at
    # 2026-05-20T00:00 with daily 08:00 and 21:00 doses is 2026-05-20T08:00.
    assert body["next_dose_scheduled_at"].startswith("2026-05-20T08:00")
    assert 0.0 <= body["next_dose_miss_probability"] <= 1.0
    assert body["next_dose_risk_tier"] in ("low", "medium", "high")
    # next_dose_dose_class mirrors the upcoming dose's class so the outreach
    # UI can render 'next dose: 21:00, psych 5mg, high risk' inline without
    # iterating predictions client-side. Derived schedule carries dose_class
    # through from history, so it should not be None here.
    assert body["next_dose_dose_class"] in ("cardio", "psych")
    # next_dose_days_out is zero-based offset from starting_at.date() to the
    # earliest scheduled dose's date; should be 0 since 2026-05-20T08:00 is
    # the same calendar day as the default starting_at=2026-05-20T00:00.
    assert body["next_dose_days_out"] == 0
    # first_high_risk_dose pointer: earliest scheduled dose in the horizon
    # whose risk_tier == 'high', ties broken by dose_id; null when no dose
    # is high risk. Dose-level analogue of first_high_risk_day.
    high_preds = [
        (day["date"], day) for day in body["by_day"] if day["high_risk_count"] > 0
    ]
    if not high_preds:
        assert body["first_high_risk_dose_id"] is None
        assert body["first_high_risk_dose_scheduled_at"] is None
        assert body["first_high_risk_dose_miss_probability"] == 0.0
        assert body["first_high_risk_dose_dose_class"] is None
        assert body["first_high_risk_dose_days_out"] == -1
    else:
        assert body["first_high_risk_dose_id"] is not None
        assert body["first_high_risk_dose_scheduled_at"] is not None
        # The dose must land on first_high_risk_day (earliest day with any
        # high-risk dose), since the earliest high-risk dose can't be later
        # than the earliest high-risk day.
        assert body["first_high_risk_dose_scheduled_at"].startswith(
            body["first_high_risk_day"]
        )
        assert 0.0 <= body["first_high_risk_dose_miss_probability"] <= 1.0
        assert body["first_high_risk_dose_dose_class"] in ("cardio", "psych")
        # first_high_risk_dose_days_out must match first_high_risk_day_days_out
        # since the earliest high-risk dose lands on the first high-risk day.
        assert body["first_high_risk_dose_days_out"] == body["first_high_risk_day_days_out"]
        assert body["first_high_risk_dose_days_out"] >= 0
    # peak_risk_dose pointer: single highest-miss_probability dose across the
    # horizon, ties broken by earliest scheduled_at then dose_id. Dose-level
    # analogue of worst_day (peak miss volume per day).
    assert body["peak_risk_dose_id"] is not None
    assert body["peak_risk_dose_scheduled_at"] is not None
    assert 0.0 <= body["peak_risk_dose_miss_probability"] <= 1.0
    assert body["peak_risk_dose_risk_tier"] in ("low", "medium", "high")
    assert body["peak_risk_dose_dose_class"] is None or body["peak_risk_dose_dose_class"] in ("cardio", "psych")
    assert body["peak_risk_dose_days_out"] >= 0
    # peak must be at least as high as next_dose and first_high_risk_dose
    # miss_probability; if a high-risk dose exists, peak must be high tier.
    assert body["peak_risk_dose_miss_probability"] >= body["next_dose_miss_probability"]
    if body["first_high_risk_dose_id"] is not None:
        assert body["peak_risk_dose_risk_tier"] == "high"
        assert (
            body["peak_risk_dose_miss_probability"]
            >= body["first_high_risk_dose_miss_probability"]
        )


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


def test_forecast_derived_schedule_skips_past_doses_on_day_zero(tmp_path, monkeypatch):
    """A forecast requested mid-day must not include dose times that have
    already passed on day zero (e.g. an 08:00 dose when called at 15:00).
    Those events can no longer be acted on and would pollute the projection."""
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    # Caller wakes up at 15:00 UTC; history has doses at 08:00 (already past)
    # and 21:00 (still to come). Day zero should only carry the 21:00 dose.
    payload = {
        "user_id": "u_forecast_midday",
        "history": _history_for("u_forecast_midday"),
        "horizon_days": 3,
        "starting_at": "2026-05-20T15:00:00+00:00",
        "bootstrap_iterations": 0,
    }
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["schedule_source"] == "derived"
    # 2 doses/day across days 1 and 2, plus only the 21:00 dose on day 0 = 5
    assert body["n_doses_scored"] == 5
    day_zero = body["by_day"][0]
    assert day_zero["date"] == "2026-05-20"
    assert day_zero["n_doses"] == 1
    for day in body["by_day"][1:]:
        assert day["n_doses"] == 2
    # next_dose should be the day-zero 21:00 dose, not the morning 08:00 dose
    # that already passed before the 15:00 call.
    assert body["next_dose_scheduled_at"].startswith("2026-05-20T21:00")


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


def test_forecast_include_predictions_opt_in(tmp_path, monkeypatch):
    """include_predictions=true returns per-dose rows; default omits them."""
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {
        "user_id": "u_forecast_1",
        "history": _history_for(),
        "horizon_days": 3,
        "starting_at": "2026-05-20T00:00:00+00:00",
        "bootstrap_iterations": 0,
    }
    # Default: predictions omitted (null) to keep payload small.
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    assert r.json().get("predictions") is None

    # Opt-in: predictions populated, sorted by scheduled_at then dose_id, and
    # internally consistent with the aggregates the response already reports.
    payload["include_predictions"] = True
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    preds = body["predictions"]
    assert isinstance(preds, list)
    assert len(preds) == body["n_doses_scored"] == 6  # 2 doses/day * 3 days
    keys = [(p["scheduled_at"], p["dose_id"]) for p in preds]
    assert keys == sorted(keys)
    for p in preds:
        assert 0.0 <= p["miss_probability"] <= 1.0
        assert p["risk_tier"] in ("low", "medium", "high")
        assert p["dose_class"] is None or p["dose_class"] in ("cardio", "psych")
    # Aggregates derived from predictions must match the reported totals.
    assert abs(sum(p["miss_probability"] for p in preds) - body["total_expected_misses"]) < 1e-6
    assert sum(1 for p in preds if p["risk_tier"] == "high") == body["total_high_risk_count"]
    # First prediction must match the next_dose pointer.
    assert preds[0]["dose_id"] == body["next_dose_id"]
    assert preds[0]["scheduled_at"].startswith(body["next_dose_scheduled_at"][:16])


def test_forecast_predictions_min_risk_tier_filter(tmp_path, monkeypatch):
    """predictions_min_risk_tier filters the per-dose list; aggregates unchanged."""
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {
        "user_id": "u_forecast_1",
        "history": _history_for(),
        "horizon_days": 3,
        "starting_at": "2026-05-20T00:00:00+00:00",
        "bootstrap_iterations": 0,
        "include_predictions": True,
    }
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    full = r.json()
    full_preds = full["predictions"]
    n_high = sum(1 for p in full_preds if p["risk_tier"] == "high")
    n_med_or_high = sum(1 for p in full_preds if p["risk_tier"] in ("medium", "high"))

    # Filter to high only: list shrinks, aggregates do not.
    payload["predictions_min_risk_tier"] = "high"
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert all(p["risk_tier"] == "high" for p in body["predictions"])
    assert len(body["predictions"]) == n_high
    # Roll-up aggregates are computed against the full horizon, unaffected by filter.
    assert body["n_doses_scored"] == full["n_doses_scored"]
    assert body["total_high_risk_count"] == full["total_high_risk_count"]
    assert abs(body["total_expected_misses"] - full["total_expected_misses"]) < 1e-9

    # Filter to medium-or-above.
    payload["predictions_min_risk_tier"] = "medium"
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert all(p["risk_tier"] in ("medium", "high") for p in body["predictions"])
    assert len(body["predictions"]) == n_med_or_high

    # 'low' is a no-op (returns all scored doses), matching current behavior.
    payload["predictions_min_risk_tier"] = "low"
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    assert len(r.json()["predictions"]) == len(full_preds)

    # Filter is a no-op when include_predictions is false (predictions stays null).
    payload["include_predictions"] = False
    payload["predictions_min_risk_tier"] = "high"
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    assert r.json().get("predictions") is None


def test_forecast_predictions_limit_top_n(tmp_path, monkeypatch):
    """predictions_limit caps the list to top-N by miss_probability desc; aggregates unchanged."""
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {
        "user_id": "u_forecast_1",
        "history": _history_for(),
        "horizon_days": 5,
        "starting_at": "2026-05-20T00:00:00+00:00",
        "bootstrap_iterations": 0,
        "include_predictions": True,
    }
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    full = r.json()
    full_preds = full["predictions"]
    assert len(full_preds) > 3
    assert full.get("predictions_truncated") is False

    # Cap at 3 highest-miss_probability doses.
    payload["predictions_limit"] = 3
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    capped = body["predictions"]
    assert len(capped) == 3
    assert body["predictions_truncated"] is True
    # Sorted by miss_probability desc.
    probs = [p["miss_probability"] for p in capped]
    assert probs == sorted(probs, reverse=True)
    # Returned rows are exactly the top 3 of the full set.
    top3_expected = sorted(
        full_preds,
        key=lambda p: (-p["miss_probability"], p["scheduled_at"], p["dose_id"]),
    )[:3]
    assert [p["dose_id"] for p in capped] == [p["dose_id"] for p in top3_expected]
    # Roll-up aggregates unaffected by the cap.
    assert body["n_doses_scored"] == full["n_doses_scored"]
    assert abs(body["total_expected_misses"] - full["total_expected_misses"]) < 1e-9
    assert body["total_high_risk_count"] == full["total_high_risk_count"]

    # Cap >= eligible count: predictions_truncated stays false.
    payload["predictions_limit"] = len(full_preds) + 10
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["predictions"]) == len(full_preds)
    assert body["predictions_truncated"] is False

    # Limit composes with predictions_min_risk_tier: filter first, then cap.
    payload["predictions_limit"] = 2
    payload["predictions_min_risk_tier"] = "medium"
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    body = r.json()
    n_med_or_high = sum(1 for p in full_preds if p["risk_tier"] in ("medium", "high"))
    assert len(body["predictions"]) == min(2, n_med_or_high)
    assert all(p["risk_tier"] in ("medium", "high") for p in body["predictions"])
    assert body["predictions_truncated"] is (n_med_or_high > 2)

    # Limit is a no-op when include_predictions is false.
    payload["include_predictions"] = False
    r = c.post("/v1/forecast/user", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    assert r.json().get("predictions") is None
    assert r.json().get("predictions_truncated") is False


def test_forecast_user_csv_export(tmp_path, monkeypatch):
    """POST /v1/forecast/user.csv returns one CSV row per scored dose."""
    import csv as _csv
    import io as _io

    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    payload = {
        "user_id": "u_forecast_csv",
        "history": _history_for("u_forecast_csv"),
        "horizon_days": 3,
        "starting_at": "2026-05-20T00:00:00+00:00",
        "bootstrap_iterations": 0,
    }
    r = c.post("/v1/forecast/user.csv", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert "attachment;" in r.headers["content-disposition"]
    assert "u_forecast_csv" in r.headers["content-disposition"]
    assert r.headers["x-schedule-source"] == "derived"
    assert r.headers["x-predictions-truncated"] == "false"
    # 2 doses/day * 3 days = 6
    assert r.headers["x-row-count"] == "6"
    assert r.headers.get("x-model-name") == "default"
    assert r.headers.get("x-model-version")

    reader = _csv.reader(_io.StringIO(r.text))
    rows = list(reader)
    assert rows[0] == [
        "dose_id", "scheduled_at", "days_out", "miss_probability", "risk_tier", "dose_class",
    ]
    data = rows[1:]
    assert len(data) == 6
    # Sorted chronologically by scheduled_at when no limit set.
    iso_col = [r[1] for r in data]
    assert iso_col == sorted(iso_col)
    # All scheduled_at end with Z (UTC).
    for row in data:
        assert row[1].endswith("Z")
        assert 0 <= int(row[2]) <= 2
        miss_p = float(row[3])
        assert 0.0 <= miss_p <= 1.0
        assert row[4] in {"low", "medium", "high"}

    # predictions_limit caps at top-N by miss_probability desc.
    payload["predictions_limit"] = 2
    r = c.post("/v1/forecast/user.csv", json=payload, headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    assert r.headers["x-row-count"] == "2"
    assert r.headers["x-predictions-truncated"] == "true"
    data = list(_csv.reader(_io.StringIO(r.text)))[1:]
    assert len(data) == 2
    # Sorted by miss_probability desc.
    assert float(data[0][3]) >= float(data[1][3])


def test_forecast_user_csv_requires_service_role(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _train()
    from adherence_api.app import create_app
    c = TestClient(create_app())
    payload = {
        "user_id": "u_forecast_csv",
        "history": _history_for("u_forecast_csv"),
        "horizon_days": 2,
        "starting_at": "2026-05-20T00:00:00+00:00",
        "bootstrap_iterations": 0,
    }
    r = c.post("/v1/forecast/user.csv", json=payload, headers={"x-api-key": "vwr"})
    assert r.status_code in (401, 403)
