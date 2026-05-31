"""Scope enforcement middleware tests.

Proves that a DB-backed API key with a narrow scope set cannot reach
mutating routes outside that set, while keys with an empty scope set
(legacy "role-only" gating) continue to work.
"""
from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_file = tmp_path / "scopes.db"
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{db_file}")
    monkeypatch.setenv("ADHERENCE_API_KEYS", "")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "test-secret-test-secret-test-secret")
    # Rate limit is per-key; make it generous so it doesn't shadow our 403.
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


def _mk_key(name: str, role: str, scopes: list[str], tenant: str = "default") -> str:
    from adherence_common import api_keys as ak

    plain, _ = ak.create_key(name=name, role=role, tenant_id=tenant, scopes=scopes)
    return plain


def test_scope_catalog_endpoint_lists_canonical_scopes():
    client = _client()
    key = _mk_key("introspect", role="viewer", scopes=["predict:read"])
    r = client.get("/v1/auth/scopes", headers={"x-api-key": key})
    assert r.status_code == 200
    body = r.json()
    assert "predict:write" in body["scopes"]
    assert "admin:keys" in body["scopes"]
    assert body["effective_scopes"] == ["predict:read"]
    assert body["unlimited_scopes"] is False
    # Catalog entries carry method + prefix + scope.
    entry = next(c for c in body["catalog"] if c["scope"] == "admin:members")
    assert entry["prefix"].startswith("/v1/admin/memberships")


def test_scoped_key_denied_outside_its_allowlist():
    """A key scoped to predict:read may not mint admin tokens."""
    client = _client()
    key = _mk_key("ro", role="admin", scopes=["predict:read"])
    r = client.post(
        "/v1/admin/token",
        headers={"x-api-key": key},
        json={"subject": "u1", "role": "viewer"},
    )
    assert r.status_code == 403, r.text
    body = r.json()
    assert body["error"] == "insufficient_scope"
    assert body["required_scope"] == "admin:keys"
    assert r.headers.get("X-Required-Scope") == "admin:keys"


def test_scoped_key_allowed_within_its_allowlist():
    """Same admin-role key, but with the right scope, succeeds at the
    middleware layer (route may still 4xx for other reasons; we only
    assert the scope check did not block it)."""
    client = _client()
    key = _mk_key("ok", role="admin", scopes=["admin:keys"])
    r = client.post(
        "/v1/admin/token",
        headers={"x-api-key": key},
        json={"subject": "u1", "role": "viewer"},
    )
    # Either the route succeeds (200) or fails for a reason that is not
    # the scope middleware (anything other than insufficient_scope).
    assert r.status_code != 403 or r.json().get("error") != "insufficient_scope", r.text


def test_empty_scope_set_preserves_legacy_role_only_gating():
    """A key with no scopes still works (legacy behaviour preserved)."""
    client = _client()
    key = _mk_key("legacy", role="admin", scopes=[])
    r = client.post(
        "/v1/admin/token",
        headers={"x-api-key": key},
        json={"subject": "u1", "role": "viewer"},
    )
    # No 403 with insufficient_scope: empty scope set bypasses enforcement.
    assert not (r.status_code == 403 and r.json().get("error") == "insufficient_scope"), r.text


def test_check_endpoint_dry_runs_decision():
    client = _client()
    key = _mk_key("checker", role="viewer", scopes=["predict:read"])
    r = client.get(
        "/v1/auth/scopes/check",
        params={"method": "POST", "path": "/v1/admin/memberships"},
        headers={"x-api-key": key},
    )
    assert r.status_code == 200
    assert r.json()["decision"] == "denied"
    assert r.json()["required_scope"] == "admin:members"
