"""Integration tests for JWT session revocation.

Covers three guarantees enterprise buyers ask about:

1. A fresh JWT minted by ``/v1/admin/token`` is accepted.
2. Revoking that single token by ``jti`` immediately rejects subsequent
   requests with HTTP 401 (no need to wait for ``exp``).
3. ``revoke-all`` invalidates every JWT issued for the principal at or
   before the cutoff (the "sign out every device" flow), while a token
   minted after the cutoff still works.
"""
from __future__ import annotations

import time

import jwt
from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/sessions.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client: TestClient, subject: str = "alice", role: str = "viewer") -> dict:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": "acme"},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    decoded = jwt.decode(body["token"], "x" * 32, algorithms=["HS256"])
    assert "jti" in decoded, "mint_jwt must include a jti claim"
    return {"token": body["token"], "claims": decoded}


def _viewer_call(client: TestClient, token: str):
    # /v1/quota/me is viewer-readable and exercises the JWT verify path.
    return client.get(
        "/v1/quota/me",
        headers={"Authorization": f"Bearer {token}"},
    )


def test_revoke_jti_blocks_single_token(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    minted = _mint(client)
    token = minted["token"]
    jti = minted["claims"]["jti"]

    # Live token works.
    r1 = _viewer_call(client, token)
    assert r1.status_code == 200, r1.text

    # Revoke it.
    r2 = client.post(
        "/v1/admin/sessions/revoke",
        json={"jti": jti, "sub": "alice", "tenant": "acme",
              "reason": "laptop lost"},
        headers={"x-api-key": "adm"},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["kind"] == "jti"

    # Same token is now rejected.
    r3 = _viewer_call(client, token)
    assert r3.status_code == 401, r3.text
    assert "revoked" in r3.text.lower()

    # Audit row landed.
    r4 = client.get(
        "/v1/admin/audit/admin?action=session.revoke&limit=5",
        headers={"x-api-key": "adm"},
    )
    assert r4.status_code == 200, r4.text
    rows = r4.json()
    assert any(row["target"] == jti for row in rows)


def test_revoke_all_invalidates_old_tokens_only(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    old = _mint(client, subject="bob")
    # Live before revoke.
    assert _viewer_call(client, old["token"]).status_code == 200

    # Bulk revoke for sub=bob (tenant acme).
    time.sleep(1.05)  # ensure new tokens have a strictly greater iat
    r = client.post(
        "/v1/admin/sessions/revoke-all",
        json={"sub": "bob", "tenant": "acme",
              "reason": "offboarding"},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "all"

    # Old token must now fail.
    r2 = _viewer_call(client, old["token"])
    assert r2.status_code == 401, r2.text

    # A freshly minted token for the same principal works again.
    time.sleep(1.05)
    fresh = _mint(client, subject="bob")
    r3 = _viewer_call(client, fresh["token"])
    assert r3.status_code == 200, r3.text


def test_revoke_dry_run_does_not_revoke(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    minted = _mint(client, subject="carol")
    token = minted["token"]
    jti = minted["claims"]["jti"]

    r = client.post(
        f"/v1/admin/sessions/revoke?dry_run=true",
        json={"jti": jti, "sub": "carol", "tenant": "acme"},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True
    assert body["would_revoke"] is True

    # Token still works.
    assert _viewer_call(client, token).status_code == 200
