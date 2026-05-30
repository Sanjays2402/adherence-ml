"""Tests for per-user intervention mute (TTL opt-out)."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/m.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod, deliveries as dmod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def test_set_and_get_mute_via_api(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    svc = {"x-api-key": "svc"}

    r = c.get("/v1/users/u1/mute", headers=svc)
    assert r.status_code == 200
    assert r.json() is None

    r = c.put(
        "/v1/users/u1/mute",
        json={"duration_minutes": 60, "reason": "hospitalized"},
        headers=svc,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["active"] is True
    assert body["reason"] == "hospitalized"

    r = c.get("/v1/users/u1/mute", headers=svc)
    assert r.status_code == 200
    body = r.json()
    assert body["active"] is True
    assert body["user_id"] == "u1"


def test_clear_mute(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    svc = {"x-api-key": "svc"}

    # 404 if nothing to clear
    r = c.delete("/v1/users/u404/mute", headers=svc)
    assert r.status_code == 404

    c.put("/v1/users/u1/mute", json={"duration_minutes": 60}, headers=svc)
    r = c.delete("/v1/users/u1/mute", headers=svc)
    assert r.status_code == 200
    r = c.get("/v1/users/u1/mute", headers=svc)
    assert r.json()["active"] is False


def test_duration_validation(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    svc = {"x-api-key": "svc"}
    r = c.put("/v1/users/u1/mute", json={"duration_minutes": 0}, headers=svc)
    assert r.status_code == 422
    r = c.put(
        "/v1/users/u1/mute",
        json={"duration_minutes": 60 * 24 * 365},
        headers=svc,
    )
    assert r.status_code == 422


def test_admin_list_active(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    svc = {"x-api-key": "svc"}
    admin = {"x-api-key": "adm"}

    for u in ("u1", "u2", "u3"):
        c.put(f"/v1/users/{u}/mute", json={"duration_minutes": 30}, headers=svc)
    r = c.get("/v1/admin/mutes", headers=admin)
    assert r.status_code == 200
    rows = r.json()
    assert {row["user_id"] for row in rows} == {"u1", "u2", "u3"}

    # Viewers / service tokens can't see the admin overview
    r = c.get("/v1/admin/mutes", headers=svc)
    assert r.status_code == 403


def test_expired_mute_not_active(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import mutes as mm

    mm.set_mute("u_e", duration_minutes=1)
    # Force expiry
    from adherence_common.db import UserMute, session
    from sqlalchemy import update
    with session() as s:
        s.execute(
            update(UserMute)
            .where(UserMute.user_id == "u_e")
            .values(muted_until=datetime.utcnow() - timedelta(seconds=5))
        )
        s.commit()
    assert mm.is_muted("u_e") is None
    st = mm.get_mute("u_e")
    assert st is not None and st.active is False


def _train_and_app(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_worker import inference as inf
    inf.load_model.cache_clear()
    from adherence_trainer.pipeline import run_training
    run_training(synthetic=True, users=60, days=10, seed=11,
                 register_as="default", use_mlflow=False, cv_splits=0)
    from adherence_api.app import create_app
    return TestClient(create_app())


def test_muted_user_interventions_suppressed_no_deliveries(tmp_path, monkeypatch):
    c = _train_and_app(tmp_path, monkeypatch)
    svc = {"x-api-key": "svc"}
    c.put(
        "/v1/users/u_000001/mute",
        json={"duration_minutes": 120, "reason": "vacation"},
        headers=svc,
    )
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
    r = c.post("/v1/interventions", json=payload, headers=svc)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mute"] is not None
    assert body["mute"]["active"] is True
    assert body["mute"]["reason"] == "vacation"
    # Predictions still flow through
    assert len(body["predictions"]) == 2
    # Every surfaced intervention must be marked suppressed by mute
    for iv in body["interventions"]:
        assert iv["suppressed"] is True
        assert iv["suppress_reason"] == "user_muted"
        assert iv["delivery_id"] is None
