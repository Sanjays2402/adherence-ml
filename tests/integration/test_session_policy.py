"""Integration test: per-workspace session max-age policy.

Proves the enterprise guarantee that a workspace admin can cap how long
a JWT session is honoured inside their tenant. Specifically:

1. A freshly minted JWT works against a viewer-readable endpoint.
2. Setting ``max_age_seconds`` to a value smaller than the token's age
   causes the previously-valid token to be rejected with HTTP 401 on
   the very next call. No need to wait for ``exp``.
3. The policy is tenant-scoped: capping ``acme`` does not affect a
   token minted for tenant ``globex``.
4. Every mutation lands in the admin audit log so SOC2 reviewers can
   trace who tightened the cap and when.
"""
from __future__ import annotations

import time

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/sesspol.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client: TestClient, *, subject: str, tenant: str, role: str = "viewer") -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _admin_for(client: TestClient, tenant: str) -> str:
    return _mint(client, subject=f"admin-{tenant}", tenant=tenant, role="admin")


def _viewer_call(client: TestClient, token: str):
    return client.get(
        "/v1/quota/me",
        headers={"Authorization": f"Bearer {token}"},
    )


def test_session_policy_caps_and_isolates_per_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    # Read default (no policy yet) using an acme-scoped admin JWT.
    acme_admin = _admin_for(client, "acme")
    r0 = client.get(
        "/v1/workspace/session-policy",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r0.status_code == 200, r0.text
    assert r0.json()["tenant_id"] == "acme"
    assert r0.json()["max_age_seconds"] is None

    # Tighten acme to the minimum public cap (60s).
    r_set = client.put(
        "/v1/workspace/session-policy",
        json={"max_age_seconds": 60},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_set.status_code == 200, r_set.text
    assert r_set.json()["max_age_seconds"] == 60

    # Mint tokens for both tenants and confirm both work immediately.
    acme_tok = _mint(client, subject="alice", tenant="acme")
    globex_tok = _mint(client, subject="bob", tenant="globex")
    assert _viewer_call(client, acme_tok).status_code == 200
    assert _viewer_call(client, globex_tok).status_code == 200

    # Forge a tighter cap than the public floor allows so the test stays
    # fast. The public API enforces a 60s minimum to protect operators,
    # but the in-process enforcer honours whatever is on the row.
    from adherence_common import session_policy as sp
    from adherence_common.db import session as _session
    time.sleep(2.5)
    with _session() as s:
        row = s.query(sp.WorkspaceSessionPolicy).filter_by(tenant_id="acme").one()
        row.max_age_seconds = 1
        s.commit()

    # acme is now capped at 1s and the token is older than that.
    r_acme = _viewer_call(client, acme_tok)
    assert r_acme.status_code == 401, r_acme.text
    assert "max age" in r_acme.text.lower()

    # globex is untouched and the token still works.
    r_globex = _viewer_call(client, globex_tok)
    assert r_globex.status_code == 200, r_globex.text

    # Audit trail: the public PUT recorded an admin action.
    r_audit = client.get(
        "/v1/admin/audit/admin?action=workspace.session_policy.set&tenant=*&limit=5",
        headers={"x-api-key": "adm"},
    )
    assert r_audit.status_code == 200, r_audit.text
    actions = [row["action"] for row in r_audit.json()]
    assert "workspace.session_policy.set" in actions

    # Clearing the policy lifts the cap so a fresh token works again.
    acme_admin2 = _admin_for(client, "acme")
    r_del = client.delete(
        "/v1/workspace/session-policy",
        headers={"Authorization": f"Bearer {acme_admin2}"},
    )
    assert r_del.status_code == 200, r_del.text
    fresh = _mint(client, subject="alice", tenant="acme")
    assert _viewer_call(client, fresh).status_code == 200


def test_session_policy_validates_range(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_tok = _mint(client, subject="admin-x", tenant="acme", role="admin")
    # Below the floor: pydantic rejects with 422.
    r_low = client.put(
        "/v1/workspace/session-policy",
        json={"max_age_seconds": 5},
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r_low.status_code == 422, r_low.text

    # Above the ceiling: pydantic rejects with 422.
    r_high = client.put(
        "/v1/workspace/session-policy",
        json={"max_age_seconds": 60 * 60 * 24 * 365},
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r_high.status_code == 422, r_high.text


def test_session_policy_requires_admin(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    # Viewer can read.
    r_get = client.get(
        "/v1/workspace/session-policy",
        headers={"x-api-key": "vwr"},
    )
    assert r_get.status_code == 200, r_get.text

    # Viewer cannot mutate.
    r_put = client.put(
        "/v1/workspace/session-policy",
        json={"max_age_seconds": 300},
        headers={"x-api-key": "vwr"},
    )
    assert r_put.status_code in (401, 403), r_put.text
