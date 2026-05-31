"""Webhook HMAC secret rotation with overlap window.

Enterprise receivers cannot stop their consumers, swap secrets, and
restart in one atomic step. A rotation has to leave the *old* secret
valid for a brief window so in-flight deliveries keep validating while
the receiver rolls its stored secret over.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr",
    )
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/rot.db")
    monkeypatch.setenv(
        "ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns",
    )
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_PRIVATE", "true")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_HTTP", "true")
    reload_settings()
    from adherence_common import audit as audit_mod, deliveries as dmod
    from adherence_common import outbound as omod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    omod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _create_sub(client: TestClient, name: str = "clinic-rot") -> dict:
    r = client.put(
        "/v1/webhooks/outbound/subscriptions",
        json={
            "name": name,
            "url": "https://example.test/hook",
            "event_types": ["intervention.high_risk"],
            "active": True,
            "secret": "originalsecret-pleaserotate",
        },
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_rotate_secret_dry_run_does_not_mutate(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    _create_sub(client)

    r = client.post(
        "/v1/webhooks/outbound/subscriptions/clinic-rot/rotate-secret"
        "?dry_run=true",
        json={"overlap_minutes": 30},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "clinic-rot"
    assert body["secret"] and body["secret"] != "originalsecret-pleaserotate"
    assert body["secret_previous_active"] is True

    # The stored row must be untouched.
    r2 = client.get(
        "/v1/webhooks/outbound/subscriptions",
        headers={"x-api-key": "adm"},
    )
    row = next(s for s in r2.json() if s["name"] == "clinic-rot")
    assert row["secret_previous_active"] is False


def test_rotate_secret_overlap_signs_with_both(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_common import outbound as omod

    client = TestClient(create_app())
    _create_sub(client)

    r = client.post(
        "/v1/webhooks/outbound/subscriptions/clinic-rot/rotate-secret",
        json={"overlap_minutes": 60},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    rot = r.json()
    new_secret = rot["secret"]
    assert rot["secret_previous_active"] is True
    assert rot["secret_previous_expires_at"]
    assert new_secret != "originalsecret-pleaserotate"

    captured: list[dict[str, Any]] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        captured.append({
            "headers": dict(request.headers),
            "body": request.content,
        })
        return httpx.Response(200, text="ok")

    transport = httpx.MockTransport(_handler)
    test_client = httpx.Client(transport=transport, timeout=2.0)
    omod.dispatch(
        "intervention.high_risk", {"patient_id": "p1", "risk": 0.93},
        _client=test_client,
    )
    assert captured, "expected at least one delivery attempt"
    h = captured[0]["headers"]
    body = captured[0]["body"]
    assert "x-adherence-signature" in h
    assert "x-adherence-signature-previous" in h, (
        "expected previous-signature header during overlap window"
    )
    # New secret verifies the primary signature.
    assert omod.verify(new_secret, body, h["x-adherence-signature"])
    # Old secret verifies the previous-signature header.
    assert omod.verify(
        "originalsecret-pleaserotate", body,
        h["x-adherence-signature-previous"],
    )
    # And verify_any covers either-secret receivers.
    assert omod.verify_any(
        [new_secret, "originalsecret-pleaserotate"], body,
        h["x-adherence-signature"],
    )


def test_rotate_secret_zero_overlap_hard_cut(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_common import outbound as omod

    client = TestClient(create_app())
    _create_sub(client)
    r = client.post(
        "/v1/webhooks/outbound/subscriptions/clinic-rot/rotate-secret",
        json={"overlap_minutes": 0},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    rot = r.json()
    assert rot["secret_previous_active"] is False
    assert rot["secret_previous_expires_at"] is None

    captured: list[dict[str, Any]] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        captured.append(dict(request.headers))
        return httpx.Response(200, text="ok")

    omod.dispatch(
        "intervention.high_risk", {"patient_id": "p2", "risk": 0.91},
        _client=httpx.Client(
            transport=httpx.MockTransport(_handler), timeout=2.0,
        ),
    )
    assert captured
    assert "x-adherence-signature-previous" not in captured[0]


def test_rotate_secret_requires_admin(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    _create_sub(client)
    r = client.post(
        "/v1/webhooks/outbound/subscriptions/clinic-rot/rotate-secret",
        json={"overlap_minutes": 10},
        headers={"x-api-key": "vwr"},
    )
    assert r.status_code in (401, 403)


def test_rotate_secret_unknown_subscription_404(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    r = client.post(
        "/v1/webhooks/outbound/subscriptions/no-such/rotate-secret",
        json={"overlap_minutes": 10},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 404
