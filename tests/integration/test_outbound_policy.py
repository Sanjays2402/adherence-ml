"""Outbound destination policy: SSRF defense at subscription create and
at dispatch time. These tests cover the deal-blocker enterprise checks:
metadata endpoints, private/loopback IPs, scheme restriction, and the
hostname allowlist.
"""
from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch, *, allow_private="false", allow_http="false", allowlist=""):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/p.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_PRIVATE", allow_private)
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_HTTP", allow_http)
    monkeypatch.setenv("ADHERENCE_OUTBOUND_HOST_ALLOWLIST", allowlist)
    reload_settings()
    from adherence_common import audit as audit_mod, deliveries as dmod
    from adherence_common import outbound as omod
    audit_mod._INITIALIZED = False
    dmod._INITIALIZED = False
    omod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _client():
    from adherence_api.app import create_app
    return TestClient(create_app())


def test_pure_evaluator_blocks_metadata_and_loopback_and_private(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import outbound_policy as pol

    for url in (
        "http://169.254.169.254/latest/meta-data/",
        "https://metadata.google.internal/computeMetadata/v1/",
        "http://127.0.0.1:6379/",
        "http://10.0.0.5/hook",
        "http://192.168.1.10/hook",
        "http://[::1]/hook",
        "ftp://example.com/",
        "http://user:pass@example.com/",
    ):
        d = pol.evaluate(url)
        assert not d.allowed, f"expected block for {url!r}"
        assert d.reason

    # https public host with valid DNS is allowed.
    ok = pol.evaluate("https://example.com/hook")
    assert ok.allowed, ok.reason
    assert ok.resolved_ips


def test_create_subscription_rejects_loopback(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    c = _client()
    r = c.put(
        "/v1/webhooks/outbound/subscriptions",
        json={"name": "evil", "url": "http://127.0.0.1/hook", "active": True},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["detail"]["code"] == "outbound_blocked"
    assert "loopback" in body["detail"]["reason"] or "http" in body["detail"]["reason"]


def test_create_subscription_rejects_metadata_endpoint(tmp_path, monkeypatch):
    # Even with private + http allowed, the metadata endpoint must stay blocked.
    _setup(tmp_path, monkeypatch, allow_private="true", allow_http="true")
    c = _client()
    r = c.put(
        "/v1/webhooks/outbound/subscriptions",
        json={"name": "imds", "url": "http://169.254.169.254/latest/meta-data/iam/", "active": True},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 400, r.text
    assert "metadata" in r.json()["detail"]["reason"]


def test_dispatch_records_blocked_when_subscription_url_violates_policy(tmp_path, monkeypatch):
    # Create with permissive settings, then tighten and dispatch.
    _setup(tmp_path, monkeypatch, allow_private="true", allow_http="true")
    c = _client()
    r = c.put(
        "/v1/webhooks/outbound/subscriptions",
        json={"name": "internal", "url": "http://10.0.0.5/hook", "active": True},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text

    # Now tighten the policy: private no longer allowed. Dispatch must
    # refuse and record a blocked delivery (no HTTP attempt).
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_PRIVATE", "false")
    monkeypatch.setenv("ADHERENCE_OUTBOUND_ALLOW_HTTP", "false")
    reload_settings()

    from adherence_common import outbound as omod
    # If dispatch tried HTTP this client would record the call; the
    # blocked path must not invoke it.
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        ids = omod.dispatch("anything", {"k": 1}, _client=client)

    assert calls == [], f"dispatch must not POST when policy blocks: {calls}"
    assert len(ids) == 1
    # Verify the delivery row is state='blocked' via the API.
    r = c.get("/v1/webhooks/outbound/deliveries?limit=5", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    deliveries = r.json()
    assert deliveries
    last = deliveries[0]
    assert last["state"] == "blocked"
    assert last["status_code"] is None
    assert "outbound_blocked" in (last["error"] or "")


def test_hostname_allowlist_blocks_unlisted_hosts(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, allowlist="example.com,.iana.org")
    from adherence_common import outbound_policy as pol

    # Exact match (example.com resolves to a public IP).
    assert pol.evaluate("https://example.com/x").allowed
    # Suffix match (www.iana.org).
    assert pol.evaluate("https://www.iana.org/x").allowed
    # Apex of suffix entry alone does NOT match (entry was ``.iana.org``).
    d = pol.evaluate("https://iana.org/x")
    assert not d.allowed
    assert "allowlist" in d.reason
    # Some other host.
    d = pol.evaluate("https://example.org/x")
    assert not d.allowed
    assert "allowlist" in d.reason


def test_policy_get_and_check_endpoints(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch, allowlist="example.com")
    c = _client()
    r = c.get("/v1/webhooks/outbound/policy", headers={"x-api-key": "adm"})
    assert r.status_code == 200
    body = r.json()
    assert body["allow_http"] is False
    assert body["allow_private"] is False
    assert body["host_allowlist"] == ["example.com"]

    r = c.post(
        "/v1/webhooks/outbound/policy/check",
        json={"url": "http://127.0.0.1/hook"},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["allowed"] is False
    assert body["reason"]
