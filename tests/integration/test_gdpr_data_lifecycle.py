"""Tests for GDPR data export and erasure endpoints."""
from __future__ import annotations

from datetime import datetime, timedelta

from adherence_common.settings import reload_settings
from fastapi.testclient import TestClient


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/g.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    from adherence_common import deliveries as dmod
    from adherence_common import gdpr as gdpr_mod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    gdpr_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _seed(user_id: str = "u_gdpr_1") -> None:
    from adherence_common.db import (
        DoseOutcome,
        InterventionDelivery,
        NotificationBudget,
        PredictionAudit,
        PredictionRow,
        QuietHoursPolicy,
        UserMute,
        UserRiskPolicy,
        init_db,
        session,
    )
    init_db()
    now = datetime.utcnow()
    with session() as s:
        s.add_all([
            PredictionRow(
                user_id=user_id, dose_id="d1", scheduled_at=now,
                miss_probability=0.42, risk_tier="medium",
                model_version="v1",
            ),
            PredictionAudit(
                request_id="r1", route="/v1/predict", user_id=user_id,
                caller="api-key", caller_role="service",
                model_name="default", model_version="v1",
                n_doses=1, high_risk_count=0, ok=1,
            ),
            DoseOutcome(
                user_id=user_id, dose_id="d1", scheduled_at=now,
                outcome="taken",
            ),
            InterventionDelivery(
                request_id="r1", user_id=user_id, action="nudge",
                channel="push", score=0.42, state="recommended",
            ),
            UserMute(
                user_id=user_id, muted_until=now + timedelta(hours=1),
                reason="test",
            ),
            QuietHoursPolicy(
                user_id=user_id, tz="UTC", start_hour=22, end_hour=7,
            ),
            NotificationBudget(user_id=user_id, daily_limit=5),
            UserRiskPolicy(
                scope_type="user", scope_id=user_id,
                low_max=0.3, medium_max=0.7,
            ),
            # Unrelated user, must NOT be touched
            PredictionRow(
                user_id="someone_else", dose_id="dx", scheduled_at=now,
                miss_probability=0.1, risk_tier="low", model_version="v1",
            ),
            UserMute(
                user_id="someone_else",
                muted_until=now + timedelta(hours=1),
            ),
        ])
        s.commit()


def test_export_returns_all_user_rows(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _seed()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.get("/v1/users/u_gdpr_1/data", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user_id"] == "u_gdpr_1"
    counts = body["counts"]
    assert counts["predictions"] == 1
    assert counts["prediction_audit"] == 1
    assert counts["dose_outcomes"] == 1
    assert counts["intervention_deliveries"] == 1
    assert counts["user_mutes"] == 1
    assert counts["quiet_hours_policies"] == 1
    assert counts["notification_budgets"] == 1
    assert counts["user_risk_policies"] == 1
    # The unrelated user's row must not appear
    pred_rows = body["tables"]["predictions"]
    assert all(row["user_id"] == "u_gdpr_1" for row in pred_rows)


def test_export_requires_admin_or_scope(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _seed()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.get("/v1/users/u_gdpr_1/data", headers={"x-api-key": "vwr"})
    assert r.status_code == 403
    r = c.get("/v1/users/u_gdpr_1/data", headers={"x-api-key": "svc"})
    assert r.status_code == 403
    r = c.get("/v1/users/u_gdpr_1/data")
    assert r.status_code == 401


def test_erase_deletes_only_target_user(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _seed()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.delete("/v1/users/u_gdpr_1/data", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user_id"] == "u_gdpr_1"
    assert body["total"] >= 8
    assert body["deleted"]["predictions"] == 1
    assert body["deleted"]["user_mutes"] == 1
    assert body["deleted"]["user_risk_policies"] == 1

    # Re-export now returns zero rows for the erased user
    r = c.get("/v1/users/u_gdpr_1/data", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    body2 = r.json()
    assert all(v == 0 for v in body2["counts"].values())

    # Other user's data is untouched
    r = c.get("/v1/users/someone_else/data", headers={"x-api-key": "adm"})
    body3 = r.json()
    assert body3["counts"]["predictions"] == 1
    assert body3["counts"]["user_mutes"] == 1


def test_erase_requires_admin(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    _seed()
    from adherence_api.app import create_app
    c = TestClient(create_app())

    r = c.delete("/v1/users/u_gdpr_1/data", headers={"x-api-key": "svc"})
    assert r.status_code == 403
    r = c.delete("/v1/users/u_gdpr_1/data", headers={"x-api-key": "vwr"})
    assert r.status_code == 403


def test_erase_is_idempotent_on_unknown_user(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    r = c.delete("/v1/users/ghost_user/data", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 0
