"""Cross-endpoint test for ``?dry_run=true`` on destructive routes.

Validates the enterprise change-management contract:

* ``dry_run=true`` returns ``{"dry_run": True, "would_<verb>": True}``.
* No state changes (a follow-up read still returns the original row).
* ``dry_run=true`` against a missing target still returns 404, matching
  the real call. Operators cannot use the preview to discover whether a
  target exists for some other tenant.
"""
from __future__ import annotations

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/dry.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_PRIVATE", "true")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_HTTP", "true")
    reload_settings()
    from adherence_common import audit as audit_mod, deliveries as dmod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def test_mute_dry_run_does_not_clear(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    svc = {"x-api-key": "svc"}

    r = c.put(
        "/v1/users/u-dry/mute",
        json={"duration_minutes": 60, "reason": "preview-test"},
        headers=svc,
    )
    assert r.status_code == 200, r.text
    assert r.json()["active"] is True

    r = c.delete("/v1/users/u-dry/mute?dry_run=true", headers=svc)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"dry_run": True, "would_clear": True, "user_id": "u-dry"}

    r = c.get("/v1/users/u-dry/mute", headers=svc)
    assert r.status_code == 200
    after = r.json()
    assert after is not None and after["active"] is True, (
        "dry_run must not clear the mute"
    )

    r = c.delete("/v1/users/u-dry/mute", headers=svc)
    assert r.status_code == 200 and r.json()["cleared"] is True


def test_mute_dry_run_missing_returns_404(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    svc = {"x-api-key": "svc"}

    r = c.delete("/v1/users/u-missing/mute?dry_run=true", headers=svc)
    assert r.status_code == 404


def test_webhook_subscription_dry_run_preserves_row(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    c = TestClient(create_app())
    adm = {"x-api-key": "adm"}

    r = c.put(
        "/v1/webhooks/outbound/subscriptions",
        json={
            "name": "preview-hook",
            "url": "https://example.invalid/hook",
            "event_types": ["test.ping"],
            "secret": "x" * 32,
            "active": True,
        },
        headers=adm,
    )
    assert r.status_code == 200, r.text

    r = c.delete(
        "/v1/webhooks/outbound/subscriptions/preview-hook?dry_run=true",
        headers=adm,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["dry_run"] is True
    assert body["would_delete"] is True
    assert body["name"] == "preview-hook"
    assert "subscription_id" in body

    r = c.get("/v1/webhooks/outbound/subscriptions", headers=adm)
    assert r.status_code == 200
    names = [row["name"] for row in r.json()]
    assert "preview-hook" in names, "dry_run must not delete the subscription"

    r = c.delete(
        "/v1/webhooks/outbound/subscriptions/preview-hook",
        headers=adm,
    )
    assert r.status_code == 200 and r.json()["deleted"] is True
