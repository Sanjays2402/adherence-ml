"""Tests for quiet-hours intervention filtering."""
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from adherence_common.quiet_hours import QuietHours, apply
from adherence_common.settings import reload_settings


def test_quiet_hours_contains_simple_window():
    qh = QuietHours(user_id="u", tz="UTC", start_hour=22, end_hour=7)
    # 23:00 UTC is inside the wrap-midnight window
    assert qh.contains(datetime(2026, 5, 30, 23, 0, tzinfo=timezone.utc))
    assert qh.contains(datetime(2026, 5, 31, 3, 0, tzinfo=timezone.utc))
    # 09:00 is outside
    assert not qh.contains(datetime(2026, 5, 30, 9, 0, tzinfo=timezone.utc))


def test_quiet_hours_contains_non_wrap():
    qh = QuietHours(user_id="u", tz="UTC", start_hour=13, end_hour=14)
    assert qh.contains(datetime(2026, 5, 30, 13, 30, tzinfo=timezone.utc))
    assert not qh.contains(datetime(2026, 5, 30, 14, 0, tzinfo=timezone.utc))
    assert not qh.contains(datetime(2026, 5, 30, 12, 59, tzinfo=timezone.utc))


def test_apply_defers_blocked_channel():
    qh = QuietHours(user_id="u", tz="UTC", start_hour=22, end_hour=7,
                    allowed_channels=("email",))
    ivs = [{
        "action": "push_reminder", "score": 0.8, "channel": "app",
        "target_dose_ids": ["d1"], "reason": "x", "lead_time_minutes": 30,
    }]
    # dose at 03:30 UTC tomorrow; fire = 03:00 (inside window 22-07)
    dose_times = {"d1": "2026-05-31T03:30:00+00:00"}
    now = datetime(2026, 5, 30, 22, 0, tzinfo=timezone.utc)
    out, info = apply(ivs, qh, dose_times=dose_times, now=now)
    # fire_at = 03:00 -> still leaves enough time before dose at 03:30 to defer
    # to next 07:00, but that's AFTER the dose -> suppress
    assert info["applied"] is True
    assert info["n_suppressed"] == 1
    assert out == []


def test_apply_passes_allowed_channel_through():
    qh = QuietHours(user_id="u", tz="UTC", start_hour=22, end_hour=7,
                    allowed_channels=("email",))
    ivs = [{
        "action": "education_card", "score": 0.5, "channel": "email",
        "target_dose_ids": ["d1"], "reason": "x", "lead_time_minutes": 60,
    }]
    dose_times = {"d1": "2026-05-31T03:30:00+00:00"}
    now = datetime(2026, 5, 30, 22, 0, tzinfo=timezone.utc)
    out, info = apply(ivs, qh, dose_times=dose_times, now=now)
    assert len(out) == 1
    assert info["n_suppressed"] == 0
    assert info["n_deferred"] == 0


def test_apply_defers_when_window_ends_before_dose():
    qh = QuietHours(user_id="u", tz="UTC", start_hour=22, end_hour=7)
    # dose at 09:00, lead 30min -> fire at 08:30 = OUTSIDE window
    ivs = [{
        "action": "push_reminder", "score": 0.7, "channel": "app",
        "target_dose_ids": ["d1"], "reason": "x", "lead_time_minutes": 30,
    }]
    dose_times = {"d1": "2026-05-31T09:00:00+00:00"}
    now = datetime(2026, 5, 30, 22, 0, tzinfo=timezone.utc)
    out, info = apply(ivs, qh, dose_times=dose_times, now=now)
    assert len(out) == 1 and "deferred_until" not in out[0]
    assert info["n_deferred"] == 0


def test_apply_deferred_field_set_when_room_to_shift():
    qh = QuietHours(user_id="u", tz="UTC", start_hour=22, end_hour=7)
    # dose at 12:00 UTC, lead 5h -> fire at 07:00... edge case; use lead 5h+1min
    ivs = [{
        "action": "push_reminder", "score": 0.7, "channel": "app",
        "target_dose_ids": ["d1"], "reason": "x", "lead_time_minutes": 360,  # 6h
    }]
    dose_times = {"d1": "2026-05-31T12:00:00+00:00"}  # fire = 06:00 (inside)
    now = datetime(2026, 5, 30, 22, 0, tzinfo=timezone.utc)
    out, info = apply(ivs, qh, dose_times=dose_times, now=now)
    # defer to 07:00, dose still later at 12:00 -> deferred (not suppressed)
    assert info["n_deferred"] == 1
    assert info["n_suppressed"] == 0
    assert out[0]["deferred_until"].startswith("2026-05-31T07:00")


def test_apply_none_policy_is_passthrough():
    ivs = [{"action": "x", "score": 0.1, "channel": "app",
            "target_dose_ids": ["d1"], "reason": "r", "lead_time_minutes": 0}]
    out, info = apply(ivs, None)
    assert out == ivs
    assert info["applied"] is False


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    reload_settings()
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=9,
                 register_as="default", use_mlflow=False, cv_splits=0)


def test_quiet_hours_admin_crud(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    h_admin = {"x-api-key": "adm"}
    body = {"user_id": "u_qh", "tz": "America/Los_Angeles",
            "start_hour": 22, "end_hour": 7, "allowed_channels": ["email"]}
    r = client.put("/v1/policies/quiet-hours", headers=h_admin, json=body)
    assert r.status_code == 200, r.text
    assert r.json()["allowed_channels"] == ["email"]
    r = client.get("/v1/policies/quiet-hours/u_qh", headers=h_admin)
    assert r.status_code == 200 and r.json()["start_hour"] == 22
    r = client.delete("/v1/policies/quiet-hours/u_qh", headers=h_admin)
    assert r.status_code == 200
    r = client.get("/v1/policies/quiet-hours/u_qh", headers=h_admin)
    assert r.status_code == 404


def test_quiet_hours_validation(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    body = {"user_id": "u_x", "tz": "UTC", "start_hour": 7, "end_hour": 7}
    r = client.put("/v1/policies/quiet-hours", headers={"x-api-key": "adm"}, json=body)
    assert r.status_code == 400


def test_interventions_endpoint_applies_quiet_hours(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    # 24h-wide window with no allowed channels -> everything in window suppressed
    body_qh = {"user_id": "u_iv", "tz": "UTC",
               "start_hour": 0, "end_hour": 23, "allowed_channels": []}
    client.put("/v1/policies/quiet-hours", headers={"x-api-key": "adm"}, json=body_qh)
    payload = {
        "user_id": "u_iv",
        "schedule": [{"dose_id": "d1",
                      "scheduled_at": "2026-06-01T05:00:00Z",
                      "dose_class": "cardio", "dose_strength_mg": 10.0}],
        "top_k_reasons": 0,
    }
    # First check baseline (skip quiet hours)
    r0 = client.post("/v1/interventions?respect_quiet_hours=false",
                     headers={"x-api-key": "svc"}, json=payload)
    assert r0.status_code == 200
    n0 = len(r0.json()["interventions"])
    # Now with quiet hours
    r1 = client.post("/v1/interventions",
                     headers={"x-api-key": "svc"}, json=payload)
    assert r1.status_code == 200
    n1 = len(r1.json()["interventions"])
    assert r1.json()["quiet_hours"]["applied"] is True
    # quiet hours should reduce (or at worst defer) the interventions
    assert n1 <= n0
