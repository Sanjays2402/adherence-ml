"""Webhook event catalog tests.

Proves that:

* The catalog is non-empty and exposes the documented event types.
* The ``/v1/webhooks/event-catalog`` endpoint returns the catalog to an
  authenticated viewer key with the ``webhooks:read`` scope.
* ``PUT /v1/webhooks/outbound/subscriptions`` rejects an unknown
  event_type with a structured 400.
* A subscription created in tenant A is invisible to tenant B (tenant
  isolation, exercised via the existing per-tenant query path).
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "webhook_catalog.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    monkeypatch.setenv("ADHERENCE_API_KEYS", "")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "test-secret-test-secret-test-secret")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_RPS", "1000")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_BURST", "1000")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_PRIVATE", "true")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_HTTP", "true")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _client():
    from fastapi.testclient import TestClient

    from adherence_api.app import create_app
    from adherence_common.db import init_db

    init_db()
    return TestClient(create_app(), raise_server_exceptions=False)


def _mk_key(name: str, role: str, scopes: list[str], tenant: str = "default") -> str:
    from adherence_common import api_keys as ak

    plain, _ = ak.create_key(name=name, role=role, tenant_id=tenant, scopes=scopes)
    return plain


def test_catalog_module_lists_documented_events():
    from adherence_common import webhook_events

    known = webhook_events.known_event_types()
    # Sanity: catalog covers the events shipped in the API today.
    for required in {
        "test.ping",
        "intervention.recommended",
        "run.created",
        "drift.detected",
        "api_key.rotated",
        "member.invited",
    }:
        assert required in known, required
    # Every entry carries a payload example and a non-empty schema.
    for ev in webhook_events.all_events():
        assert ev["payload_example"], ev
        assert ev["payload_fields"], ev
        assert ev["stability"] in {"stable", "beta"}


def test_catalog_endpoint_returns_full_catalog():
    client = _client()
    key = _mk_key("ro", role="viewer", scopes=["webhooks:read"])
    r = client.get(
        "/v1/webhooks/event-catalog", headers={"x-api-key": key},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] >= 6
    assert "test.ping" in body["stable_event_types"]
    types = {e["event_type"] for e in body["events"]}
    assert "intervention.recommended" in types


def test_subscription_upsert_rejects_unknown_event_type():
    client = _client()
    key = _mk_key("adm", role="admin", scopes=["webhooks:write"])
    r = client.put(
        "/v1/webhooks/outbound/subscriptions",
        headers={"x-api-key": key},
        json={
            "name": "bad-sub",
            "url": "https://example.com/hook",
            "event_types": ["intervention.recommended", "totally.made.up"],
            "active": True,
        },
    )
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "unknown_event_type"
    assert "totally.made.up" in detail["unknown"]


def test_subscription_upsert_accepts_known_event_types():
    client = _client()
    key = _mk_key("adm", role="admin", scopes=["webhooks:write"])
    r = client.put(
        "/v1/webhooks/outbound/subscriptions",
        headers={"x-api-key": key},
        json={
            "name": "good-sub",
            "url": "https://example.com/hook",
            "event_types": ["intervention.recommended", "test.ping"],
            "active": True,
        },
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert sorted(out["event_types"]) == ["intervention.recommended", "test.ping"]


def test_subscription_is_tenant_scoped():
    """A subscription created by tenant A is not visible to tenant B."""
    client = _client()
    key_a = _mk_key("a-adm", role="admin", scopes=["webhooks:write"], tenant="tenant-a")
    key_b = _mk_key("b-adm", role="admin", scopes=["webhooks:write"], tenant="tenant-b")
    r = client.put(
        "/v1/webhooks/outbound/subscriptions",
        headers={"x-api-key": key_a},
        json={
            "name": "a-only",
            "url": "https://a.example.com/hook",
            "event_types": ["test.ping"],
            "active": True,
        },
    )
    assert r.status_code == 200, r.text
    r = client.get(
        "/v1/webhooks/outbound/subscriptions",
        headers={"x-api-key": key_b},
    )
    assert r.status_code == 200, r.text
    names = {s["name"] for s in r.json()}
    assert "a-only" not in names
    # And tenant B cannot hijack the name (cross-tenant guard).
    r = client.put(
        "/v1/webhooks/outbound/subscriptions",
        headers={"x-api-key": key_b},
        json={
            "name": "a-only",
            "url": "https://b.example.com/hook",
            "event_types": ["test.ping"],
            "active": True,
        },
    )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "cross_tenant_subscription"
