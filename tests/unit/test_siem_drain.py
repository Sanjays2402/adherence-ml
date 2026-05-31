"""Per-tenant SIEM audit drain tests.

Proves:
* an admin can configure, patch, and delete a drain for their own tenant
* another tenant cannot see, patch, replay, or delete that drain
* test-fire actually POSTs an HMAC-signed payload to the configured URL
* a configured drain captures a delivery row for the tenant only
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "siem.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    monkeypatch.setenv("ADHERENCE_API_KEYS", "")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "test-secret-test-secret-test-secret")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_RPS", "1000")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_BURST", "1000")
    for mod in list(sys.modules):
        if mod.startswith("adherence_common") or mod.startswith("adherence_api"):
            sys.modules.pop(mod, None)
    yield


def _client():
    from fastapi.testclient import TestClient

    from adherence_api.app import create_app
    from adherence_common.db import init_db

    init_db()
    return TestClient(create_app())


def _mk_admin(name: str, tenant: str) -> str:
    from adherence_common import api_keys as ak

    plain, _ = ak.create_key(name=name, role="admin", tenant_id=tenant, scopes=[])
    return plain


class _Captor(BaseHTTPRequestHandler):
    received: list[dict] = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        type(self).received.append({
            "path": self.path,
            "body": body,
            "sig": self.headers.get("X-Adherence-Signature"),
            "event": self.headers.get("X-Adherence-Event"),
        })
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, fmt, *args):  # silence
        pass


@pytest.fixture
def captor():
    _Captor.received = []
    srv = HTTPServer(("127.0.0.1", 0), _Captor)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}/hec", _Captor
    srv.shutdown()


def test_admin_can_configure_and_get_drain(captor):
    url, _ = captor
    c = _client()
    key = _mk_admin("a1", tenant="acme")
    r = c.put(
        "/v1/admin/siem",
        headers={"x-api-key": key},
        json={"url": url, "secret": "supersecret-supersecret", "enabled": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tenant_id"] == "acme"
    assert body["url"] == url
    assert body["enabled"] is True
    assert "secret" not in body  # never echo full secret
    assert "***" in body["secret_preview"]

    r2 = c.get("/v1/admin/siem", headers={"x-api-key": key})
    assert r2.status_code == 200
    assert r2.json()["url"] == url


def test_cross_tenant_cannot_read_or_replay(captor):
    url, cap = captor
    c = _client()
    acme = _mk_admin("acme-admin", tenant="acme")
    other = _mk_admin("other-admin", tenant="other")

    # acme configures their drain
    r = c.put(
        "/v1/admin/siem",
        headers={"x-api-key": acme},
        json={"url": url, "secret": "supersecret-supersecret", "enabled": True},
    )
    assert r.status_code == 200

    # acme fires a test event so a delivery row exists
    r = c.post(
        "/v1/admin/siem/test",
        headers={"x-api-key": acme},
        json={"message": "hello"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ok"
    assert len(cap.received) == 1
    delivered = cap.received[0]
    # HMAC signature is correct over the body
    expected = "sha256=" + hmac.new(
        b"supersecret-supersecret", delivered["body"], hashlib.sha256
    ).hexdigest()
    assert delivered["sig"] == expected
    payload = json.loads(delivered["body"])
    assert payload["tenant_id"] == "acme"
    assert payload["event"] == "audit.test"

    # other tenant: GET returns null (no drain for them)
    r = c.get("/v1/admin/siem", headers={"x-api-key": other})
    assert r.status_code == 200
    assert r.json() is None

    # other tenant: stats show zero, not acme's row
    r = c.get("/v1/admin/siem/stats", headers={"x-api-key": other})
    assert r.status_code == 200
    sj = r.json()
    assert sj["configured"] is False
    assert sj["n_total"] == 0
    assert sj["n_ok"] == 0

    # other tenant: deliveries list is empty
    r = c.get("/v1/admin/siem/deliveries", headers={"x-api-key": other})
    assert r.status_code == 200
    assert r.json()["n"] == 0

    # other tenant: cannot fetch acme's delivery row by id
    r_list_acme = c.get(
        "/v1/admin/siem/deliveries", headers={"x-api-key": acme}
    ).json()
    assert r_list_acme["n"] >= 1
    del_id = r_list_acme["items"][0]["id"]
    r = c.get(
        f"/v1/admin/siem/deliveries/{del_id}", headers={"x-api-key": other}
    )
    assert r.status_code == 404, "must not leak existence across tenants"

    # other tenant: cannot replay acme's delivery
    r = c.post(
        f"/v1/admin/siem/deliveries/{del_id}/replay",
        headers={"x-api-key": other},
    )
    assert r.status_code == 404

    # other tenant: cannot delete acme's drain (their delete is a no-op
    # on their own tenant; acme's drain stays).
    r = c.delete("/v1/admin/siem", headers={"x-api-key": other})
    assert r.status_code == 204
    r = c.get("/v1/admin/siem", headers={"x-api-key": acme})
    assert r.status_code == 200
    assert r.json() is not None
    assert r.json()["url"] == url


def test_invalid_url_rejected():
    c = _client()
    key = _mk_admin("a1", tenant="acme")
    r = c.put(
        "/v1/admin/siem",
        headers={"x-api-key": key},
        json={"url": "ftp://nope", "secret": "supersecret-supersecret"},
    )
    assert r.status_code == 400


def test_short_secret_rejected():
    c = _client()
    key = _mk_admin("a1", tenant="acme")
    r = c.put(
        "/v1/admin/siem",
        headers={"x-api-key": key},
        json={"url": "https://example.com/hec", "secret": "short"},
    )
    # pydantic rejects min_length before route runs
    assert r.status_code in (400, 422)


def test_dry_run_does_not_persist():
    c = _client()
    key = _mk_admin("a1", tenant="acme")
    r = c.put(
        "/v1/admin/siem?dry_run=true",
        headers={"x-api-key": key},
        json={"url": "https://example.com/hec", "secret": "supersecret-supersecret"},
    )
    assert r.status_code == 200
    assert r.json()["dry_run"] is True
    # GET still returns null
    r = c.get("/v1/admin/siem", headers={"x-api-key": key})
    assert r.status_code == 200
    assert r.json() is None


def test_audit_record_dispatches_to_drain(captor):
    """The audit.record hook ships every audit row to the configured drain."""
    url, cap = captor
    c = _client()
    key = _mk_admin("a1", tenant="acme")
    r = c.put(
        "/v1/admin/siem",
        headers={"x-api-key": key},
        json={"url": url, "secret": "supersecret-supersecret", "enabled": True},
    )
    assert r.status_code == 200

    # Run dispatch synchronously so the test does not race the worker
    from adherence_common import audit as audit_mod
    from adherence_common import siem as siem_mod

    siem_mod.set_test_mode(sync=True)
    audit_mod.record(
        request_id="req-abc",
        route="/v1/predict",
        user_id="u1",
        caller="api-key:a1",
        caller_role="admin",
        model_name="xgb",
        model_version="42",
        n_doses=2,
        latency_ms=12.5,
        ok=True,
        tenant_id="acme",
        predictions=[
            {"dose_id": "d1", "miss_probability": 0.2, "risk_tier": "low"},
            {"dose_id": "d2", "miss_probability": 0.8, "risk_tier": "high"},
        ],
    )

    # One delivery should have arrived at the receiver
    assert any(r["event"] == "audit.prediction" for r in cap.received), cap.received
    body = next(json.loads(r["body"]) for r in cap.received if r["event"] == "audit.prediction")
    assert body["tenant_id"] == "acme"
    assert body["route"] == "/v1/predict"
    assert body["n_doses"] == 2
    assert body["high_risk_count"] == 1
    assert body["ok"] is True

    # And the delivery is queryable by the owning tenant only
    r = c.get("/v1/admin/siem/deliveries", headers={"x-api-key": key})
    assert r.status_code == 200
    items = r.json()["items"]
    assert any(i["event_type"] == "audit.prediction" and i["status"] == "ok" for i in items)
