"""Integration tests for inbound webhook IP allowlist.

Proves that /v1/webhooks/medtracker/event:
* accepts traffic from any source when no allowlist is configured
* accepts traffic from a matching CIDR when allowlist is configured
* rejects traffic with 403 when the client IP is outside the allowlist
* runs the IP check before HMAC verification (a valid signature does
  not bypass the network gate)
* exposes the configured posture via GET /v1/webhooks/inbound/config
  without echoing secret material
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(
    tmp_path,
    monkeypatch,
    *,
    secrets: str = "",
    ip_allowlist: str = "",
):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/wh_ip.db")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_INBOUND_WEBHOOK_SECRETS", secrets)
    monkeypatch.setenv(
        "ADHERENCE_INBOUND_WEBHOOK_IP_ALLOWLIST", ip_allowlist
    )
    reload_settings()
    from adherence_common import audit as audit_mod, db as db_mod
    audit_mod._INITIALIZED = False
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _client():
    from adherence_api.app import create_app
    return TestClient(create_app())


def _payload() -> dict:
    return {
        "source": "medtracker",
        "events": [
            {
                "event_id": "evt-ip-1",
                "user_id": "u_000001",
                "dose_id": "d1",
                "scheduled_at": "2026-03-05T08:00:00Z",
                "observed_at": "2026-03-05T08:05:00Z",
                "outcome": "taken",
                "delay_minutes": 5.0,
            }
        ],
    }


def _signed_headers(secret: str, body: bytes) -> dict[str, str]:
    ts = str(int(time.time()))
    mac = hmac.new(
        secret.encode("utf-8"),
        ts.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-API-Key": "svc",
        "Content-Type": "application/json",
        "X-Webhook-Signature": f"sha256={mac}",
        "X-Webhook-Timestamp": ts,
    }


def test_no_allowlist_accepts_any_source(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, ip_allowlist="")
    client = _client()
    body = json.dumps(_payload()).encode("utf-8")
    r = client.post(
        "/v1/webhooks/medtracker/event",
        content=body,
        headers={
            "X-API-Key": "svc",
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.42",
        },
    )
    assert r.status_code == 200, r.text


def test_allowlist_accepts_matching_ip(tmp_path, monkeypatch):
    _setup(
        tmp_path,
        monkeypatch,
        secrets="medtracker:topsecret-123456",
        ip_allowlist="medtracker:198.51.100.0/24",
    )
    client = _client()
    body = json.dumps(_payload()).encode("utf-8")
    headers = _signed_headers("topsecret-123456", body)
    headers["X-Forwarded-For"] = "198.51.100.17"
    r = client.post(
        "/v1/webhooks/medtracker/event", content=body, headers=headers
    )
    assert r.status_code == 200, r.text


def test_allowlist_rejects_outside_ip_even_with_valid_signature(
    tmp_path, monkeypatch
):
    _setup(
        tmp_path,
        monkeypatch,
        secrets="medtracker:topsecret-123456",
        ip_allowlist="medtracker:198.51.100.0/24",
    )
    client = _client()
    body = json.dumps(_payload()).encode("utf-8")
    headers = _signed_headers("topsecret-123456", body)
    # Valid HMAC, wrong egress IP. The network gate must win.
    headers["X-Forwarded-For"] = "203.0.113.9"
    r = client.post(
        "/v1/webhooks/medtracker/event", content=body, headers=headers
    )
    assert r.status_code == 403, r.text
    assert "inbound webhook ip" in r.text


def test_allowlist_rejects_unparseable_client_ip(tmp_path, monkeypatch):
    _setup(
        tmp_path,
        monkeypatch,
        ip_allowlist="medtracker:198.51.100.0/24",
    )
    client = _client()
    body = json.dumps(_payload()).encode("utf-8")
    r = client.post(
        "/v1/webhooks/medtracker/event",
        content=body,
        headers={
            "X-API-Key": "svc",
            "Content-Type": "application/json",
            "X-Forwarded-For": "not-an-ip",
        },
    )
    assert r.status_code == 403, r.text


def test_inbound_config_endpoint_reports_posture(tmp_path, monkeypatch):
    _setup(
        tmp_path,
        monkeypatch,
        secrets="medtracker:topsecret-123456,rxops:another-very-secret",
        ip_allowlist="medtracker:198.51.100.0/24,medtracker:10.0.0.0/8",
    )
    client = _client()
    r = client.get(
        "/v1/webhooks/inbound/config", headers={"X-API-Key": "svc"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    sources = {row["source"]: row for row in body["sources"]}
    assert sources["medtracker"]["signed"] is True
    assert sources["medtracker"]["ip_restricted"] is True
    assert set(sources["medtracker"]["allowed_cidrs"]) == {
        "198.51.100.0/24",
        "10.0.0.0/8",
    }
    assert sources["rxops"]["signed"] is True
    assert sources["rxops"]["ip_restricted"] is False
    # Secrets themselves must never be echoed back.
    assert "topsecret-123456" not in r.text
    assert "another-very-secret" not in r.text
