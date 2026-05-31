"""Tests for DB-backed API keys with scopes, expiry, revocation."""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/k.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()


def _client(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    return TestClient(create_app())


def test_create_list_use_revoke(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}

    # Create
    r = c.post(
        "/v1/admin/api-keys",
        json={"name": "svc-A", "role": "service", "scopes": ["predict"], "note": "ci bot"},
        headers=admin,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    plaintext = body["key"]
    assert plaintext.startswith("ak_")
    assert body["scopes"] == ["predict"]
    assert body["key_prefix"] == plaintext[:12]

    # Listing never returns plaintext
    r = c.get("/v1/admin/api-keys", headers=admin)
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert "key" not in rows[0]
    assert rows[0]["name"] == "svc-A"
    assert rows[0]["revoked_at"] is None

    # Use the new key against an endpoint that requires `service` role
    r = c.get("/v1/webhooks/medtracker/recent?limit=5", headers={"x-api-key": plaintext})
    assert r.status_code == 200, r.text

    # Revoke and verify subsequent use 401s
    r = c.post("/v1/admin/api-keys/svc-A/revoke", headers=admin)
    assert r.status_code == 200
    r = c.get("/v1/webhooks/medtracker/recent?limit=5", headers={"x-api-key": plaintext})
    assert r.status_code == 401
    assert "revoked" in r.json()["detail"]


def test_duplicate_name_400(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}
    r = c.post(
        "/v1/admin/api-keys",
        json={"name": "dup", "role": "viewer"}, headers=admin,
    )
    assert r.status_code == 201
    r = c.post(
        "/v1/admin/api-keys",
        json={"name": "dup", "role": "viewer"}, headers=admin,
    )
    assert r.status_code == 400


def test_invalid_role_rejected(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post(
        "/v1/admin/api-keys",
        json={"name": "bad", "role": "superuser"},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 400


def test_expired_key_is_rejected(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import api_keys as ak
    from datetime import datetime, timedelta
    from adherence_common.db import session

    plain, row = ak.create_key(name="exp", role="viewer", ttl_seconds=60)
    # Force expiry in the past
    with session() as s:
        from adherence_common.api_keys import APIKeyRecord
        from sqlalchemy import update
        s.execute(
            update(APIKeyRecord)
            .where(APIKeyRecord.id == row.id)
            .values(expires_at=datetime.utcnow() - timedelta(seconds=5))
        )
        s.commit()

    with pytest.raises(Exception):
        ak.resolve_db_key(plain)


def test_unknown_key_returns_none(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import api_keys as ak
    assert ak.resolve_db_key("ak_not_a_real_key_at_all") is None


def test_last_used_at_updates(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    from adherence_common import api_keys as ak
    plain, row = ak.create_key(name="probe", role="viewer")
    assert ak.list_keys()[0].last_used_at is None
    ak.resolve_db_key(plain)
    assert ak.list_keys()[0].last_used_at is not None


def test_scope_gating_via_db_key(tmp_path, monkeypatch):
    """Service key with scopes={"intervene"} can't use a scope it lacks
    once an endpoint declares the requirement.
    """
    _setup(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_api.deps import require_scope
    app = create_app()

    @app.get("/v1/test/needs-predict")
    def _ep(_p=__import__("fastapi").Depends(require_scope("predict"))):
        return {"ok": True}

    c = TestClient(app)
    admin = {"x-api-key": "adm"}
    rk = c.post(
        "/v1/admin/api-keys",
        json={"name": "narrow", "role": "service", "scopes": ["intervene"]},
        headers=admin,
    ).json()["key"]

    r = c.get("/v1/test/needs-predict", headers={"x-api-key": rk})
    assert r.status_code == 403
    assert "predict" in r.json()["detail"]

    # A key with the right scope passes
    rk2 = c.post(
        "/v1/admin/api-keys",
        json={"name": "wide", "role": "service", "scopes": ["predict", "intervene"]},
        headers=admin,
    ).json()["key"]
    r = c.get("/v1/test/needs-predict", headers={"x-api-key": rk2})
    assert r.status_code == 200


def test_env_keys_still_work(tmp_path, monkeypatch):
    """Backwards compat: env-defined static keys must still authenticate."""
    c = _client(tmp_path, monkeypatch)
    r = c.get("/v1/admin/models", headers={"x-api-key": "adm"})
    assert r.status_code == 200


def test_per_key_ip_allowlist_blocks_then_admits(tmp_path, monkeypatch):
    """A per-key CIDR allowlist must reject foreign source IPs.

    Real enterprise scenario: a partner is issued a service key and pins
    it to their NAT egress range. Requests from any other IP must 403,
    requests from inside the range must succeed, even when the workspace
    has no tenant-level allowlist configured.
    """
    from adherence_common import api_keys as ak

    c = _client(tmp_path, monkeypatch)
    admin = {"x-api-key": "adm"}

    # Issue a service key.
    body = c.post(
        "/v1/admin/api-keys",
        json={"name": "partner-prod", "role": "service", "scopes": ["predict"]},
        headers=admin,
    ).json()
    plain = body["key"]

    # No restriction yet: call succeeds.
    r = c.get(
        "/v1/webhooks/medtracker/recent?limit=1",
        headers={"x-api-key": plain, "x-forwarded-for": "203.0.113.5"},
    )
    assert r.status_code == 200, r.text

    # Pin the key to 10.10.0.0/16 (and one host).
    r = c.put(
        "/v1/admin/api-keys/partner-prod/ip-allowlist",
        json={"cidrs": ["10.10.0.0/16", "198.51.100.7"]},
        headers=admin,
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["name"] == "partner-prod"
    assert "10.10.0.0/16" in out["cidrs"]
    assert "198.51.100.7/32" in out["cidrs"]

    # Round-trip: the key list must surface the new allowlist.
    rows = c.get("/v1/admin/api-keys", headers=admin).json()
    me = next(r for r in rows if r["name"] == "partner-prod")
    assert me["ip_allowlist"] == out["cidrs"]

    # Foreign IP is blocked with the new error code.
    r = c.get(
        "/v1/webhooks/medtracker/recent?limit=1",
        headers={"x-api-key": plain, "x-forwarded-for": "203.0.113.5"},
    )
    assert r.status_code == 403
    body = r.json()
    assert body.get("error") == "api_key_ip_not_allowed"
    assert body.get("key") == "partner-prod"

    # An IP inside the allowlist passes.
    r = c.get(
        "/v1/webhooks/medtracker/recent?limit=1",
        headers={"x-api-key": plain, "x-forwarded-for": "10.10.4.99"},
    )
    assert r.status_code == 200, r.text

    # A bare-IP entry also matches exactly.
    r = c.get(
        "/v1/webhooks/medtracker/recent?limit=1",
        headers={"x-api-key": plain, "x-forwarded-for": "198.51.100.7"},
    )
    assert r.status_code == 200, r.text

    # Clearing the list removes the restriction.
    r = c.put(
        "/v1/admin/api-keys/partner-prod/ip-allowlist",
        json={"cidrs": []},
        headers=admin,
    )
    assert r.status_code == 200
    assert r.json()["cidrs"] == []

    r = c.get(
        "/v1/webhooks/medtracker/recent?limit=1",
        headers={"x-api-key": plain, "x-forwarded-for": "203.0.113.5"},
    )
    assert r.status_code == 200

    # Bad CIDR returns a structured 400 and writes an audit failure row.
    r = c.put(
        "/v1/admin/api-keys/partner-prod/ip-allowlist",
        json={"cidrs": ["not-an-ip"]},
        headers=admin,
    )
    assert r.status_code == 400
    assert "invalid" in r.json()["detail"].lower()

    # Unknown key name -> 404.
    r = c.put(
        "/v1/admin/api-keys/does-not-exist/ip-allowlist",
        json={"cidrs": ["10.0.0.0/24"]},
        headers=admin,
    )
    assert r.status_code == 404

    # Direct helpers behave too.
    ak.set_key_ip_allowlist("partner-prod", ["192.0.2.0/24"])
    assert ak.get_key_ip_allowlist("partner-prod") == ["192.0.2.0/24"]
