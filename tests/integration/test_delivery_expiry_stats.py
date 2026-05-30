"""Tests for delivery expiry hygiene + stats endpoint + CLI."""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from typer.testing import CliRunner

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch, max_age=60):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/ex.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_INTERVENTION_MAX_AGE_MINUTES", str(max_age))
    reload_settings()
    from adherence_common import audit as audit_mod, deliveries as dmod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def test_expire_stale_flips_old_recommended_only(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, max_age=60)
    from adherence_common import deliveries as dmod
    from adherence_common.db import InterventionDelivery, init_db, session
    init_db()
    now = datetime.utcnow()
    with session() as s:
        old = InterventionDelivery(
            request_id="r", user_id="u", action="push_reminder", channel="app",
            score=0.5, target_dose_ids_csv="d1", reason="x", state="recommended",
            created_at=now - timedelta(minutes=90),
            updated_at=now - timedelta(minutes=90),
        )
        fresh = InterventionDelivery(
            request_id="r", user_id="u", action="sms_reminder", channel="sms",
            score=0.6, target_dose_ids_csv="d2", reason="x", state="recommended",
            created_at=now - timedelta(minutes=10),
            updated_at=now - timedelta(minutes=10),
        )
        acted = InterventionDelivery(
            request_id="r", user_id="u", action="caregiver_alert", channel="phone",
            score=0.9, target_dose_ids_csv="d3", reason="x", state="acted",
            created_at=now - timedelta(minutes=400),
            updated_at=now - timedelta(minutes=400),
        )
        s.add_all([old, fresh, acted])
        s.commit()
    n = dmod.expire_stale(60)
    assert n == 1
    with session() as s:
        rows = {r.action: r.state for r in s.query(InterventionDelivery).all()}
    assert rows == {
        "push_reminder": "expired",
        "sms_reminder": "recommended",
        "caregiver_alert": "acted",
    }


def test_stats_endpoint_aggregates_by_state_and_action(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import deliveries as dmod
    dmod.record_many(
        request_id="r1", user_id="u1",
        interventions=[
            {"action": "sms_reminder", "channel": "sms", "score": 0.5,
             "target_dose_ids": ["d1"], "reason": "x"},
            {"action": "push_reminder", "channel": "app", "score": 0.4,
             "target_dose_ids": ["d2"], "reason": "x"},
        ],
    )
    dmod.record_many(
        request_id="r2", user_id="u2",
        interventions=[{"action": "sms_reminder", "channel": "sms", "score": 0.6,
                        "target_dose_ids": ["d3"], "reason": "x"}],
    )
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.get("/v1/interventions/stats", headers={"x-api-key": "adm"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3
    assert body["unique_users"] == 2
    assert body["by_action"]["sms_reminder"] == 2
    assert body["by_state"]["recommended"] == 3


def test_expire_endpoint_requires_admin(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.post("/v1/interventions/expire", headers={"x-api-key": "svc"})
    assert r.status_code in (401, 403)
    r = client.post("/v1/interventions/expire", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    body = r.json()
    assert "expired" in body and "max_age_minutes" in body


def test_cli_expire_and_stats_commands(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, max_age=30)
    from adherence_common import deliveries as dmod
    from adherence_common.db import InterventionDelivery, init_db, session
    init_db()
    now = datetime.utcnow()
    with session() as s:
        s.add(InterventionDelivery(
            request_id="r", user_id="u", action="push_reminder", channel="app",
            score=0.5, target_dose_ids_csv="d1", reason="x", state="recommended",
            created_at=now - timedelta(hours=2), updated_at=now - timedelta(hours=2),
        ))
        s.commit()
    from adherence_cli.main import app
    runner = CliRunner()
    out = runner.invoke(app, ["expire-interventions"])
    assert out.exit_code == 0, out.output
    assert "expired 1 deliveries" in out.output
    out = runner.invoke(app, ["delivery-stats", "--window-hours", "24"])
    assert out.exit_code == 0, out.output
    assert '"total":' in out.output.replace(" ", "")
