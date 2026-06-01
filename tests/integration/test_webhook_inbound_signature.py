"""Integration tests for inbound webhook HMAC verification.

Proves that /v1/webhooks/medtracker/event:
* rejects requests when a secret is configured and no signature is sent
* rejects bad signatures / stale timestamps with 401
* accepts a properly signed envelope
* still accepts unsigned requests when no secret is configured (back-compat)
* hard-rejects unsigned requests when `inbound_webhook_require_signed=true`
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch, *, secrets: str = "", require_signed: bool = False):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/wh_sig.db")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_INBOUND_WEBHOOK_SECRETS", secrets)
    monkeypatch.setenv(
        "ADHERENCE_INBOUND_WEBHOOK_REQUIRE_SIGNED",
        "true" if require_signed else "false",
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
                "event_id": "evt-sig-1",
                "user_id": "u_000001",
                "dose_id": "d1",
                "scheduled_at": "2026-03-05T08:00:00Z",
                "observed_at": "2026-03-05T08:05:00Z",
                "outcome": "taken",
                "delay_minutes": 5.0,
            }
        ],
    }


def _sign(secret: str, ts: str, body: bytes) -> str:
    mac = hmac.new(secret.encode(), ts.encode() + b"." + body, hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def test_unsigned_allowed_when_no_secret_configured(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, secrets="")
    c = _client()
    r = c.post("/v1/webhooks/medtracker/event", json=_payload(),
               headers={"x-api-key": "svc"})
    assert r.status_code == 200, r.text


def test_unsigned_rejected_when_require_signed(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, secrets="", require_signed=True)
    c = _client()
    r = c.post("/v1/webhooks/medtracker/event", json=_payload(),
               headers={"x-api-key": "svc"})
    assert r.status_code == 401, r.text
    assert "no secret" in r.json()["detail"]


def test_missing_signature_rejected_when_secret_configured(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, secrets="medtracker:topsecret")
    c = _client()
    r = c.post("/v1/webhooks/medtracker/event", json=_payload(),
               headers={"x-api-key": "svc"})
    assert r.status_code == 401, r.text
    assert "missing" in r.json()["detail"].lower()


def test_bad_signature_rejected(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, secrets="medtracker:topsecret")
    c = _client()
    ts = str(int(time.time()))
    r = c.post(
        "/v1/webhooks/medtracker/event",
        json=_payload(),
        headers={
            "x-api-key": "svc",
            "X-Webhook-Timestamp": ts,
            "X-Webhook-Signature": "sha256=deadbeef",
        },
    )
    assert r.status_code == 401, r.text
    assert "mismatch" in r.json()["detail"].lower()


def test_stale_timestamp_rejected(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, secrets="medtracker:topsecret")
    c = _client()
    # Build a properly signed envelope but with a 1-hour-old timestamp.
    body = json.dumps(_payload()).encode()
    ts = str(int(time.time()) - 3600)
    sig = _sign("topsecret", ts, body)
    r = c.post(
        "/v1/webhooks/medtracker/event",
        content=body,
        headers={
            "x-api-key": "svc",
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": ts,
            "X-Webhook-Signature": sig,
        },
    )
    assert r.status_code == 401, r.text
    assert "skew" in r.json()["detail"].lower()


def test_valid_signature_accepted(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, secrets="medtracker:topsecret")
    c = _client()
    body = json.dumps(_payload()).encode()
    ts = str(int(time.time()))
    sig = _sign("topsecret", ts, body)
    r = c.post(
        "/v1/webhooks/medtracker/event",
        content=body,
        headers={
            "x-api-key": "svc",
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": ts,
            "X-Webhook-Signature": sig,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"accepted": 1, "duplicates": 0, "n": 1}


def test_rotation_both_secrets_accepted(tmp_path, monkeypatch):
    """During HMAC secret rotation the current AND previous secret must
    both verify so the partner can cut over without coordinated downtime.
    """
    _setup(
        tmp_path, monkeypatch,
        secrets="medtracker:NEW_SECRET|OLD_SECRET",
    )
    c = _client()
    # New secret signs OK.
    body = json.dumps(_payload()).encode()
    ts = str(int(time.time()))
    r_new = c.post(
        "/v1/webhooks/medtracker/event",
        content=body,
        headers={
            "x-api-key": "svc",
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": ts,
            "X-Webhook-Signature": _sign("NEW_SECRET", ts, body),
        },
    )
    assert r_new.status_code == 200, r_new.text

    # Old secret also signs OK on a distinct event.
    payload2 = _payload()
    payload2["events"][0]["event_id"] = "evt-sig-2"
    body2 = json.dumps(payload2).encode()
    ts2 = str(int(time.time()))
    r_old = c.post(
        "/v1/webhooks/medtracker/event",
        content=body2,
        headers={
            "x-api-key": "svc",
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": ts2,
            "X-Webhook-Signature": _sign("OLD_SECRET", ts2, body2),
        },
    )
    assert r_old.status_code == 200, r_old.text

    # An unrelated third secret is still rejected.
    payload3 = _payload()
    payload3["events"][0]["event_id"] = "evt-sig-3"
    body3 = json.dumps(payload3).encode()
    ts3 = str(int(time.time()))
    r_bad = c.post(
        "/v1/webhooks/medtracker/event",
        content=body3,
        headers={
            "x-api-key": "svc",
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": ts3,
            "X-Webhook-Signature": _sign("UNRELATED", ts3, body3),
        },
    )
    assert r_bad.status_code == 401, r_bad.text


def test_inbound_config_reports_rotation_pending(tmp_path, monkeypatch):
    """Posture endpoint surfaces rotation state so the admin UI can warn
    operators that a partner has not finished cutover yet."""
    _setup(
        tmp_path, monkeypatch,
        secrets="medtracker:NEW|OLD,steady:onlyone",
    )
    c = _client()
    r = c.get(
        "/v1/webhooks/inbound/config",
        headers={"x-api-key": "svc"},
    )
    assert r.status_code == 200, r.text
    by_source = {s["source"]: s for s in r.json()["sources"]}
    assert by_source["medtracker"]["rotation_pending"] is True
    assert by_source["medtracker"]["secret_count"] == 2
    assert by_source["steady"]["rotation_pending"] is False
    assert by_source["steady"]["secret_count"] == 1
