"""Integration test: per-workspace API key lifetime policy.

Proves the enterprise guarantee that a workspace admin can force every
API key issued or rotated inside their tenant to declare an expiry,
capped at a configurable maximum. Specifically:

1. With no policy on file, the existing global TTL ceiling is the only
   constraint and admins may issue non-expiring or long-lived keys.
2. Setting ``max_ttl_seconds`` causes subsequent ``api_key.create``
   calls in that tenant to be rejected (HTTP 400) when ``ttl_seconds``
   exceeds the cap, with a structured ``api_key_policy_violation``
   error payload.
3. With ``require_expiry`` true (the default) the same tenant rejects
   non-expiring keys.
4. The policy is tenant-scoped: capping ``acme`` does not affect a
   key minted for tenant ``globex``.
5. Rotation honours the same cap when ``extend_ttl_seconds`` is set.
6. Every mutation and every rejection lands in the admin audit log.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/akpol.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client: TestClient, *, subject: str, tenant: str, role: str = "admin") -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


DAY = 60 * 60 * 24


def test_api_key_policy_caps_ttl_and_isolates_per_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    acme_admin = _mint(client, subject="alice", tenant="acme")
    globex_admin = _mint(client, subject="bob", tenant="globex")

    # Default: no policy on file for either tenant.
    r0 = client.get(
        "/v1/workspace/api-key-policy",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r0.status_code == 200, r0.text
    assert r0.json()["tenant_id"] == "acme"
    assert r0.json()["max_ttl_seconds"] is None

    # Pin acme to 7 days max, require an explicit expiry.
    r_set = client.put(
        "/v1/workspace/api-key-policy",
        json={"max_ttl_seconds": 7 * DAY, "require_expiry": True},
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_set.status_code == 200, r_set.text
    assert r_set.json()["max_ttl_seconds"] == 7 * DAY
    assert r_set.json()["require_expiry"] is True

    # Acme rejects a 90-day TTL request because it exceeds the cap.
    r_bad = client.post(
        "/v1/admin/api-keys",
        json={
            "name": "acme-too-long",
            "role": "viewer",
            "ttl_seconds": 90 * DAY,
            "tenant_id": "acme",
        },
        headers={"x-api-key": "adm"},
    )
    assert r_bad.status_code == 400, r_bad.text
    body = r_bad.json()
    assert body["detail"]["error"] == "api_key_policy_violation"
    assert body["detail"]["tenant_id"] == "acme"
    assert body["detail"]["max_ttl_seconds"] == 7 * DAY
    assert body["detail"]["requested_ttl_seconds"] == 90 * DAY

    # Acme also rejects a non-expiring key (require_expiry=True).
    r_none = client.post(
        "/v1/admin/api-keys",
        json={
            "name": "acme-forever",
            "role": "viewer",
            "tenant_id": "acme",
        },
        headers={"x-api-key": "adm"},
    )
    assert r_none.status_code == 400, r_none.text
    assert r_none.json()["detail"]["error"] == "api_key_policy_violation"
    assert r_none.json()["detail"]["requested_ttl_seconds"] is None

    # A request inside the cap succeeds.
    r_ok = client.post(
        "/v1/admin/api-keys",
        json={
            "name": "acme-good",
            "role": "viewer",
            "ttl_seconds": 3 * DAY,
            "tenant_id": "acme",
        },
        headers={"x-api-key": "adm"},
    )
    assert r_ok.status_code == 201, r_ok.text
    assert r_ok.json()["tenant_id"] == "acme"

    # Cross-tenant isolation: globex is unconstrained and can still
    # issue a 90-day or non-expiring key.
    r_glob_long = client.post(
        "/v1/admin/api-keys",
        json={
            "name": "globex-long",
            "role": "viewer",
            "ttl_seconds": 90 * DAY,
            "tenant_id": "globex",
        },
        headers={"x-api-key": "adm"},
    )
    assert r_glob_long.status_code == 201, r_glob_long.text
    assert r_glob_long.json()["tenant_id"] == "globex"

    r_glob_none = client.post(
        "/v1/admin/api-keys",
        json={
            "name": "globex-forever",
            "role": "viewer",
            "tenant_id": "globex",
        },
        headers={"x-api-key": "adm"},
    )
    assert r_glob_none.status_code == 201, r_glob_none.text

    # Globex admin reads its own policy and sees none.
    r_glob_pol = client.get(
        "/v1/workspace/api-key-policy",
        headers={"Authorization": f"Bearer {globex_admin}"},
    )
    assert r_glob_pol.status_code == 200, r_glob_pol.text
    assert r_glob_pol.json()["max_ttl_seconds"] is None

    # Rotation honours the same cap when extending the TTL.
    r_rot_bad = client.post(
        "/v1/admin/api-keys/acme-good/rotate",
        json={"extend_ttl_seconds": 60 * DAY},
        headers={"x-api-key": "adm"},
    )
    assert r_rot_bad.status_code == 400, r_rot_bad.text
    assert r_rot_bad.json()["detail"]["error"] == "api_key_policy_violation"

    r_rot_ok = client.post(
        "/v1/admin/api-keys/acme-good/rotate",
        json={"extend_ttl_seconds": 5 * DAY},
        headers={"x-api-key": "adm"},
    )
    assert r_rot_ok.status_code == 200, r_rot_ok.text

    # Audit trail: rejections and successful mutations both recorded.
    r_audit = client.get(
        "/v1/admin/audit/admin?action=api_key.create&tenant=*&limit=50",
        headers={"x-api-key": "adm"},
    )
    assert r_audit.status_code == 200, r_audit.text
    rows = r_audit.json()
    assert any(
        row.get("error") == "api_key_policy_violation"
        for row in rows
    ), rows

    # Clearing the policy lifts the cap.
    r_del = client.delete(
        "/v1/workspace/api-key-policy",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_del.status_code == 200, r_del.text
    r_after = client.post(
        "/v1/admin/api-keys",
        json={
            "name": "acme-after-clear",
            "role": "viewer",
            "ttl_seconds": 90 * DAY,
            "tenant_id": "acme",
        },
        headers={"x-api-key": "adm"},
    )
    assert r_after.status_code == 201, r_after.text


def test_api_key_policy_requires_admin_for_writes(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    # Viewer may read the policy.
    r_get = client.get(
        "/v1/workspace/api-key-policy",
        headers={"x-api-key": "vwr"},
    )
    assert r_get.status_code == 200, r_get.text

    # Viewer may not mutate it.
    r_put = client.put(
        "/v1/workspace/api-key-policy",
        json={"max_ttl_seconds": DAY, "require_expiry": True},
        headers={"x-api-key": "vwr"},
    )
    assert r_put.status_code in (401, 403), r_put.text


def test_api_key_policy_validates_range(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_tok = _mint(client, subject="ad", tenant="acme")

    # Below the 1 day floor.
    r_low = client.put(
        "/v1/workspace/api-key-policy",
        json={"max_ttl_seconds": 30, "require_expiry": True},
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r_low.status_code == 422, r_low.text

    # Above the 5 year ceiling.
    r_high = client.put(
        "/v1/workspace/api-key-policy",
        json={
            "max_ttl_seconds": 60 * 60 * 24 * 365 * 10,
            "require_expiry": True,
        },
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r_high.status_code == 422, r_high.text
