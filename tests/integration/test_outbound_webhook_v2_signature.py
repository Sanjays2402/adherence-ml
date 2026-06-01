"""Outbound webhook v2 signature: timestamp-bound HMAC + skew enforcement.

Procurement / SOC2 reviewers always ask: "what stops an attacker who
captures one webhook delivery from replaying it forever?" The legacy v1
signature does not bind the body to a timestamp, so the answer was
"nothing in-band." This test pins the v2 contract:

  * Every outbound POST carries ``X-Adherence-Timestamp`` and
    ``X-Adherence-Signature-V2`` in addition to the legacy header.
  * ``verify_v2`` rejects a captured-and-replayed delivery once the
    timestamp skew exceeds the configured tolerance.
  * ``verify_v2`` rejects a body-tampered delivery whose timestamp is
    still fresh.
"""
from __future__ import annotations

import time

import httpx

from adherence_common import outbound as omod
from adherence_common.settings import reload_settings


def _reset_modules(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/wh2.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_PRIVATE", "true")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_HTTP", "true")
    reload_settings()
    from adherence_common import audit as audit_mod, deliveries as dmod
    from adherence_common import db as db_mod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    omod._INITIALIZED = False
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def test_sign_v2_round_trip_and_skew_reject():
    secret = "topsecret"
    body = b'{"hello":"world"}'
    ts = str(int(time.time()))
    sig = omod.sign_v2(secret, ts, body)
    ok, reason = omod.verify_v2(secret, ts, body, sig, max_skew_seconds=300)
    assert ok and reason is None, reason

    # Replay an old delivery: same body + signature but stale timestamp.
    old_ts = str(int(time.time()) - 3600)
    old_sig = omod.sign_v2(secret, old_ts, body)
    ok, reason = omod.verify_v2(
        secret, old_ts, body, old_sig, max_skew_seconds=300,
    )
    assert not ok
    assert reason and "skew" in reason

    # Tampered body, fresh timestamp.
    ok, reason = omod.verify_v2(
        secret, ts, body + b"X", sig, max_skew_seconds=300,
    )
    assert not ok
    assert reason == "signature_mismatch"

    # Missing headers fail closed.
    ok, reason = omod.verify_v2(secret, None, body, sig)
    assert not ok and reason == "missing_signature_or_timestamp"
    ok, reason = omod.verify_v2(secret, ts, body, None)
    assert not ok and reason == "missing_signature_or_timestamp"

    # Non-integer timestamp fails closed.
    ok, reason = omod.verify_v2(secret, "not-a-number", body, sig)
    assert not ok and reason == "timestamp_not_integer"


def test_dispatch_emits_timestamp_and_v2_headers(tmp_path, monkeypatch):
    _reset_modules(tmp_path, monkeypatch)
    from adherence_common.db import WebhookSubscription, init_db, session

    init_db()
    secret = "shh-rotate-me"
    with session() as s:
        s.add(WebhookSubscription(
            name="v2-receiver",
            url="http://127.0.0.1:9/hook",
            secret=secret,
            event_types_csv="intervention.high_risk",
            active=1,
            tenant_id="default",
        ))
        s.commit()

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(request.headers)
        captured["body"] = request.content
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)
    ids = omod.dispatch(
        "intervention.high_risk",
        {"patient_id": "p1", "risk": 0.91},
        _client=client,
    )
    assert ids, "no delivery recorded"

    headers = captured["headers"]
    assert "x-adherence-signature" in headers, "v1 header missing"
    assert "x-adherence-signature-v2" in headers, "v2 header missing"
    assert "x-adherence-timestamp" in headers, "timestamp header missing"

    ts = headers["x-adherence-timestamp"]
    sig_v2 = headers["x-adherence-signature-v2"]
    body = captured["body"]

    # Receiver-side verification succeeds.
    ok, reason = omod.verify_v2(secret, ts, body, sig_v2, max_skew_seconds=300)
    assert ok, reason

    # Same delivery replayed 10 minutes later: skew check rejects it.
    ok, reason = omod.verify_v2(
        secret, ts, body, sig_v2,
        max_skew_seconds=300, now=int(ts) + 600,
    )
    assert not ok
    assert reason and "skew" in reason
