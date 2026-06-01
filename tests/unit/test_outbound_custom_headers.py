"""Tests for per-subscription custom outbound webhook headers.

Proves:

* Validator rejects reserved framing, X-Adherence-*, CRLF injection, and
  oversized values.
* PUT /v1/webhooks/outbound/subscriptions/{name}/headers persists and
  GET reads back, with sensitive values redacted in the response.
* dry_run does not persist.
* Dispatcher merges custom headers AND signature headers always win,
  even if a row was tampered to override X-Adherence-*.
* Tenant isolation: tenant A cannot read or write headers on a
  subscription owned by tenant B.
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "wh_headers.db"
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


def _make_sub(client, key: str, name: str = "sub1") -> None:
    r = client.put(
        "/v1/webhooks/outbound/subscriptions",
        headers={"x-api-key": key},
        json={
            "name": name,
            "url": "https://example.com/hook",
            "event_types": ["test.ping"],
            "active": True,
        },
    )
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Validator unit tests
# ---------------------------------------------------------------------------


def test_validator_rejects_reserved_signature_prefix():
    from adherence_common import outbound_headers

    with pytest.raises(outbound_headers.HeaderValidationError) as exc:
        outbound_headers.validate_headers({"X-Adherence-Signature": "abc"})
    assert exc.value.code == "reserved_header_prefix"


def test_validator_rejects_framing_headers():
    from adherence_common import outbound_headers

    for forbidden in ("Host", "Content-Length", "Content-Type", "Transfer-Encoding"):
        with pytest.raises(outbound_headers.HeaderValidationError) as exc:
            outbound_headers.validate_headers({forbidden: "x"})
        assert exc.value.code == "reserved_header", forbidden


def test_validator_rejects_crlf_injection():
    from adherence_common import outbound_headers

    with pytest.raises(outbound_headers.HeaderValidationError) as exc:
        outbound_headers.validate_headers(
            {"X-Custom": "ok\r\nX-Injected: pwned"}
        )
    assert exc.value.code == "header_value_invalid"


def test_validator_rejects_invalid_token_name():
    from adherence_common import outbound_headers

    with pytest.raises(outbound_headers.HeaderValidationError) as exc:
        outbound_headers.validate_headers({"Bad Header": "x"})
    assert exc.value.code == "header_name_invalid"


def test_validator_enforces_count_and_size():
    from adherence_common import outbound_headers

    too_many = {f"X-N-{i}": "v" for i in range(outbound_headers.MAX_HEADERS + 1)}
    with pytest.raises(outbound_headers.HeaderValidationError) as exc:
        outbound_headers.validate_headers(too_many)
    assert exc.value.code == "too_many_headers"

    big_value = "a" * (outbound_headers.MAX_HEADER_VALUE_BYTES + 1)
    with pytest.raises(outbound_headers.HeaderValidationError) as exc:
        outbound_headers.validate_headers({"X-Big": big_value})
    assert exc.value.code == "header_value_too_long"


def test_validator_rejects_duplicate_case_insensitive():
    from adherence_common import outbound_headers

    with pytest.raises(outbound_headers.HeaderValidationError) as exc:
        outbound_headers.validate_headers({"X-Foo": "a", "x-foo": "b"})
    assert exc.value.code == "duplicate_header"


def test_redaction_masks_authorization_keeps_correlation_visible():
    from adherence_common import outbound_headers

    view = outbound_headers.redact_for_display({
        "Authorization": "Bearer secret-token",
        "X-Customer-Id": "acme-corp",
    })
    assert view["Authorization"] == outbound_headers.REDACTION
    assert view["X-Customer-Id"] == "acme-corp"


# ---------------------------------------------------------------------------
# HTTP route tests
# ---------------------------------------------------------------------------


def test_set_and_get_custom_headers_redacts_sensitive():
    client = _client()
    key = _mk_key("adm", role="admin", scopes=["webhooks:write", "webhooks:read"])
    _make_sub(client, key)
    r = client.put(
        "/v1/webhooks/outbound/subscriptions/sub1/headers",
        headers={"x-api-key": key},
        json={"headers": {
            "Authorization": "Bearer top-secret",
            "X-Customer-Tenant": "acme",
        }},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 2
    assert body["extra_headers"]["Authorization"] == "***"
    assert body["extra_headers"]["X-Customer-Tenant"] == "acme"
    assert "Authorization" in body["extra_headers_redacted_keys"]

    r = client.get(
        "/v1/webhooks/outbound/subscriptions/sub1/headers",
        headers={"x-api-key": key},
    )
    assert r.status_code == 200, r.text
    assert r.json()["extra_headers"]["Authorization"] == "***"

    # And the same redaction shows up on the main listing route.
    r = client.get(
        "/v1/webhooks/outbound/subscriptions",
        headers={"x-api-key": key},
    )
    assert r.status_code == 200, r.text
    sub = [s for s in r.json() if s["name"] == "sub1"][0]
    assert sub["extra_headers"]["Authorization"] == "***"


def test_set_custom_headers_rejects_signature_override():
    client = _client()
    key = _mk_key("adm", role="admin", scopes=["webhooks:write"])
    _make_sub(client, key)
    r = client.put(
        "/v1/webhooks/outbound/subscriptions/sub1/headers",
        headers={"x-api-key": key},
        json={"headers": {"X-Adherence-Signature": "forged"}},
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "reserved_header_prefix"


def test_dry_run_does_not_persist():
    client = _client()
    key = _mk_key("adm", role="admin", scopes=["webhooks:write", "webhooks:read"])
    _make_sub(client, key)
    r = client.put(
        "/v1/webhooks/outbound/subscriptions/sub1/headers?dry_run=true",
        headers={"x-api-key": key},
        json={"headers": {"X-Customer-Id": "acme"}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 1
    # Real read shows no persisted headers.
    r = client.get(
        "/v1/webhooks/outbound/subscriptions/sub1/headers",
        headers={"x-api-key": key},
    )
    assert r.json()["count"] == 0


def test_headers_cross_tenant_returns_404():
    client = _client()
    key_a = _mk_key("a", role="admin", scopes=["webhooks:write"], tenant="ta")
    key_b = _mk_key("b", role="admin", scopes=["webhooks:write"], tenant="tb")
    _make_sub(client, key_a, name="a-sub")
    r = client.put(
        "/v1/webhooks/outbound/subscriptions/a-sub/headers",
        headers={"x-api-key": key_b},
        json={"headers": {"X-Foo": "bar"}},
    )
    assert r.status_code == 404, r.text
    r = client.get(
        "/v1/webhooks/outbound/subscriptions/a-sub/headers",
        headers={"x-api-key": key_b},
    )
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# Dispatcher integration: custom headers ride along, signature headers win
# ---------------------------------------------------------------------------


def test_dispatch_merges_custom_headers_and_protects_signature():
    """Even if a row is tampered to override X-Adherence-Signature, the
    dispatcher must keep the real signature on the wire."""
    import json as _json

    import httpx

    from adherence_common import outbound as outbound_mod
    from adherence_common import outbound_headers
    from adherence_common.db import WebhookSubscription, init_db, session

    init_db()
    # Hand-craft a subscription whose stored JSON tries to override
    # X-Adherence-Signature in addition to setting a legitimate header.
    stored = _json.dumps({
        "Authorization": "Bearer customer-token",
        "X-Customer-Id": "acme",
        "X-Adherence-Signature": "FORGED",  # must be ignored on dispatch
        "Content-Type": "text/plain",        # framing override, must be ignored
    })
    with session() as s:
        row = WebhookSubscription(
            name="tampered",
            url="https://example.com/hook",
            secret="s" * 32,
            event_types_csv="test.ping",
            active=1,
            tenant_id="default",
            extra_headers_json=stored,
        )
        s.add(row)
        s.commit()

    captured: dict = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(request.headers)
        return httpx.Response(200)

    transport = httpx.MockTransport(_handler)
    with httpx.Client(transport=transport) as client:
        ids = outbound_mod.dispatch(
            "test.ping",
            {"hello": "world"},
            _client=client,
        )
    assert ids, "expected one delivery"
    sent = captured["headers"]
    # Custom header rode along.
    assert sent.get("authorization") == "Bearer customer-token"
    assert sent.get("x-customer-id") == "acme"
    # Signature was NOT overridden by the tampered row.
    assert sent.get("x-adherence-signature") != "FORGED"
    assert sent.get("x-adherence-signature", "").startswith("sha256=")
    # Framing stayed JSON.
    assert sent.get("content-type") == "application/json"
    # Validator should also reject the tampered shape at admin time.
    with pytest.raises(outbound_headers.HeaderValidationError):
        outbound_headers.validate_headers(_json.loads(stored))
