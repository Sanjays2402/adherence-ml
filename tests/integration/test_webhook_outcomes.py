"""Integration tests for /v1/webhooks/medtracker/event."""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/wh.db")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod, db as db_mod
    audit_mod._INITIALIZED = False
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _client():
    from adherence_api.app import create_app
    return TestClient(create_app())


def _event(i: int, outcome: str = "taken") -> dict:
    return {
        "event_id": f"evt-{i}",
        "user_id": "u_000001",
        "dose_id": f"d{i}",
        "scheduled_at": f"2026-03-05T0{i + 1}:00:00Z",
        "observed_at": f"2026-03-05T0{i + 1}:05:00Z",
        "outcome": outcome,
        "delay_minutes": 5.0 if outcome == "late" else 0.0,
    }


def test_webhook_persists_outcomes(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.post(
        "/v1/webhooks/medtracker/event",
        json={"source": "medtracker",
              "events": [_event(0), _event(1, "missed"), _event(2, "late")]},
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"accepted": 3, "duplicates": 0, "n": 3}

    r = c.get("/v1/webhooks/medtracker/recent?limit=10",
              headers={"x-api-key": "svc"})
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 3
    outcomes = sorted(i["outcome"] for i in items)
    assert outcomes == ["late", "missed", "taken"]


def test_webhook_is_idempotent_on_event_id(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    payload = {"source": "medtracker", "events": [_event(0), _event(1)]}
    r1 = c.post("/v1/webhooks/medtracker/event", json=payload,
                headers={"x-api-key": "svc"})
    assert r1.json() == {"accepted": 2, "duplicates": 0, "n": 2}
    r2 = c.post("/v1/webhooks/medtracker/event", json=payload,
                headers={"x-api-key": "svc"})
    assert r2.json() == {"accepted": 0, "duplicates": 2, "n": 2}


def test_webhook_rejects_bad_outcome(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    bad = _event(0)
    bad["outcome"] = "yes"
    r = c.post("/v1/webhooks/medtracker/event",
               json={"events": [bad]}, headers={"x-api-key": "svc"})
    assert r.status_code == 422


def test_webhook_requires_service_role(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.post("/v1/webhooks/medtracker/event",
               json={"events": [_event(0)]}, headers={"x-api-key": "vwr"})
    assert r.status_code == 403
