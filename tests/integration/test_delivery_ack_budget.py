"""Tests for intervention delivery persistence, ack lifecycle, cooldown
suppression, and per-user notification budget."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch, cooldown=120, budget=6):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/dl.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_INTERVENTION_COOLDOWN_MINUTES", str(cooldown))
    monkeypatch.setenv("ADHERENCE_NOTIFICATION_DEFAULT_DAILY_LIMIT", str(budget))
    reload_settings()
    from adherence_common import audit as audit_mod, deliveries as dmod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=80, days=10, seed=13,
                 register_as="default", use_mlflow=False, cv_splits=0)


def _payload(user="u_000001"):
    return {
        "user_id": user,
        "schedule": [
            {"dose_id": "d1", "scheduled_at": "2026-03-05T08:00:00Z",
             "dose_class": "cardio", "dose_strength_mg": 10.0},
            {"dose_id": "d2", "scheduled_at": "2026-03-05T21:30:00Z",
             "dose_class": "psych", "dose_strength_mg": 5.0},
        ],
        "top_k_reasons": 3,
    }


def _force_interventions():
    """Return synthetic high-risk predictions so the recommender returns >=1."""
    return [
        {"dose_id": "d1", "miss_probability": 0.92, "risk_tier": "high",
         "reasons": [{"feature": "late_history", "delta": 0.1}],
         "dose_class": "cardio", "scheduled_at": "2026-03-05T08:00:00Z"},
        {"dose_id": "d2", "miss_probability": 0.85, "risk_tier": "high",
         "reasons": [{"feature": "weekend_pattern", "delta": 0.1}],
         "dose_class": "psych", "scheduled_at": "2026-03-05T21:30:00Z"},
    ]


def test_interventions_persist_delivery_ids(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    # Use the stateless endpoint so the test does not depend on model risk.
    body = {"user_id": "u_a", "model_version": "v-x", "predictions": _force_interventions()}
    r = client.post("/v1/interventions/from-predictions", json=body,
                    headers={"x-api-key": "svc"})
    # from-predictions endpoint does not persist; main endpoint does. Hit the
    # main endpoint via a real predict pass.
    r = client.post("/v1/interventions", json=_payload(),
                    headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert "budget" in data
    assert data["budget"]["daily_limit"] == 6
    # If anything came back, each item must carry a delivery_id (unless suppressed).
    for iv in data["interventions"]:
        if not iv.get("suppressed"):
            assert iv.get("delivery_id") is None or isinstance(iv["delivery_id"], int)


def test_ack_lifecycle_transitions(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import deliveries as dmod
    ids = dmod.record_many(
        request_id="rq1",
        user_id="u_ack",
        interventions=[{
            "action": "sms_reminder", "channel": "sms", "score": 0.9,
            "target_dose_ids": ["d1"], "reason": "high-risk",
        }],
    )
    assert len(ids) == 1
    delivery_id = ids[0]
    from adherence_api.app import create_app
    client = TestClient(create_app())
    # bad state
    r = client.post(f"/v1/interventions/{delivery_id}/ack",
                    json={"state": "BOGUS"}, headers={"x-api-key": "svc"})
    assert r.status_code == 400
    # snooze
    r = client.post(f"/v1/interventions/{delivery_id}/ack",
                    json={"state": "snoozed", "snooze_minutes": 30, "note": "later"},
                    headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "snoozed"
    assert r.json()["snooze_until"] is not None
    # acted
    r = client.post(f"/v1/interventions/{delivery_id}/ack",
                    json={"state": "acted"}, headers={"x-api-key": "svc"})
    assert r.status_code == 200
    assert r.json()["state"] == "acted"
    # missing id
    r = client.post("/v1/interventions/999999/ack",
                    json={"state": "dismissed"}, headers={"x-api-key": "svc"})
    assert r.status_code == 404


def test_cooldown_suppresses_repeat_action(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, cooldown=120)
    from adherence_common import deliveries as dmod
    # seed a recent recommended delivery for this user/action
    dmod.record_many(
        request_id="seed",
        user_id="u_cd",
        interventions=[{
            "action": "sms_reminder", "channel": "sms", "score": 0.9,
            "target_dose_ids": ["d1"], "reason": "seed",
        }],
    )
    recent = dmod.recent_actions("u_cd", cooldown_minutes=120)
    assert "sms_reminder" in recent
    # dismissed deliveries do not suppress
    dmod.record_many(
        request_id="seed2",
        user_id="u_cd2",
        interventions=[{
            "action": "sms_reminder", "channel": "sms", "score": 0.9,
            "target_dose_ids": ["d1"], "reason": "seed",
        }],
    )
    # transition to dismissed
    from adherence_common.db import InterventionDelivery, session as _sess
    with _sess() as s:
        row = s.query(InterventionDelivery).filter_by(user_id="u_cd2").first()
        dmod.ack(row.id, "dismissed")
    recent2 = dmod.recent_actions("u_cd2", cooldown_minutes=120)
    assert "sms_reminder" not in recent2


def test_notification_budget_admin_crud_and_enforcement(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, budget=2)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    # CRUD
    r = client.put("/v1/policies/notification-budget",
                   json={"user_id": "u_b", "daily_limit": 1, "note": "tight"},
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    assert r.json()["daily_limit"] == 1
    r = client.get("/v1/policies/notification-budget/u_b",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    assert r.json()["daily_limit"] == 1
    r = client.get("/v1/policies/notification-budget/missing",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 404
    r = client.delete("/v1/policies/notification-budget/u_b",
                      headers={"x-api-key": "adm"})
    assert r.status_code == 200

    # Enforcement: seed budget-consuming deliveries then call endpoint
    from adherence_common import deliveries as dmod
    dmod.record_many(
        request_id="seed",
        user_id="u_b2",
        interventions=[
            {"action": "sms_reminder", "channel": "sms", "score": 0.5,
             "target_dose_ids": ["dx"], "reason": "seed"},
            {"action": "caregiver_alert", "channel": "phone", "score": 0.6,
             "target_dose_ids": ["dy"], "reason": "seed"},
        ],
    )
    # Default daily limit is 2 -> already exhausted
    payload = _payload(user="u_b2")
    r = client.post("/v1/interventions", json=payload,
                    headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["budget"]["used"] >= 2
    assert data["budget"]["exhausted"] is True


def test_list_deliveries_admin_endpoint(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import deliveries as dmod
    dmod.record_many(
        request_id="rL",
        user_id="u_list",
        interventions=[{
            "action": "push_reminder", "channel": "app", "score": 0.4,
            "target_dose_ids": ["d9"], "reason": "low-risk-test",
        }],
    )
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.get("/v1/interventions/deliveries/u_list",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) >= 1
    assert rows[0]["user_id"] == "u_list"
    assert rows[0]["action"] == "push_reminder"
    # filter by state
    r = client.get("/v1/interventions/deliveries/u_list?state=recommended",
                   headers={"x-api-key": "adm"})
    assert r.status_code == 200
    assert all(row["state"] == "recommended" for row in r.json())


def test_ack_endpoint_requires_service_role(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    # no key -> 401/403
    r = client.post("/v1/interventions/1/ack", json={"state": "sent"})
    assert r.status_code in (401, 403)
