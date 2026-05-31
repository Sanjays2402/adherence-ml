"""Integration test: per-workspace cap on simultaneously-active API keys.

Proves the enterprise guarantee that a workspace admin can pin the
maximum number of live API keys in their tenant *below* the plan seat
ceiling. Specifically:

1. With no cap set, the existing global / plan limits apply.
2. Setting ``max_active_keys`` causes subsequent ``api_key.create``
   calls in that tenant to be rejected (HTTP 400,
   ``active_key_limit_exceeded``) once the cap is hit, with a
   structured error payload.
3. Revoking an existing key frees a slot.
4. The cap is tenant-scoped: pinning ``acme`` does not affect
   ``globex``.
5. The rejection is recorded in the admin audit log.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/akmax.db")
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


def test_max_active_keys_caps_create_and_isolates_tenant(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    acme_admin = _mint(client, subject="alice", tenant="acme")
    _ = _mint(client, subject="bob", tenant="globex")

    # Cap acme to two simultaneously-active keys. Leave require_expiry
    # off and pick a generous TTL ceiling so this test only proves the
    # count cap, not the lifetime cap.
    r_set = client.put(
        "/v1/workspace/api-key-policy",
        json={
            "max_ttl_seconds": 365 * DAY,
            "require_expiry": False,
            "max_active_keys": 2,
        },
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_set.status_code == 200, r_set.text
    assert r_set.json()["max_active_keys"] == 2

    # First two keys land fine.
    r1 = client.post(
        "/v1/admin/api-keys",
        json={"name": "acme-one", "role": "viewer", "tenant_id": "acme"},
        headers={"x-api-key": "adm"},
    )
    assert r1.status_code == 201, r1.text
    r2 = client.post(
        "/v1/admin/api-keys",
        json={"name": "acme-two", "role": "viewer", "tenant_id": "acme"},
        headers={"x-api-key": "adm"},
    )
    assert r2.status_code == 201, r2.text

    # Third key is rejected with the structured error.
    r3 = client.post(
        "/v1/admin/api-keys",
        json={"name": "acme-three", "role": "viewer", "tenant_id": "acme"},
        headers={"x-api-key": "adm"},
    )
    assert r3.status_code == 400, r3.text
    body = r3.json()
    assert body["detail"]["error"] == "active_key_limit_exceeded"
    assert body["detail"]["tenant_id"] == "acme"
    assert body["detail"]["active_keys"] == 2
    assert body["detail"]["max_active_keys"] == 2

    # Cross-tenant isolation: globex is unconstrained and can mint a
    # third (or more) keys without tripping acme's cap.
    for name in ("globex-one", "globex-two", "globex-three"):
        rg = client.post(
            "/v1/admin/api-keys",
            json={"name": name, "role": "viewer", "tenant_id": "globex"},
            headers={"x-api-key": "adm"},
        )
        assert rg.status_code == 201, rg.text

    # Revoke one acme key, slot frees, a new one succeeds.
    rr = client.post(
        "/v1/admin/api-keys/acme-one/revoke",
        headers={"x-api-key": "adm"},
    )
    assert rr.status_code == 200, rr.text

    r4 = client.post(
        "/v1/admin/api-keys",
        json={"name": "acme-four", "role": "viewer", "tenant_id": "acme"},
        headers={"x-api-key": "adm"},
    )
    assert r4.status_code == 201, r4.text

    # Audit trail records the rejection.
    r_audit = client.get(
        "/v1/admin/audit/admin?action=api_key.create&limit=200",
        headers={"Authorization": f"Bearer {acme_admin}"},
    )
    assert r_audit.status_code == 200, r_audit.text
    rows = r_audit.json()
    assert isinstance(rows, list), rows
    rejected = [
        r for r in rows
        if (r.get("error") or "") == "active_key_limit_exceeded"
        and (r.get("target") or "") == "acme-three"
    ]
    assert rejected, f"expected an active_key_limit_exceeded audit row, got {rows!r}"
    assert rejected[0].get("ok") is False


def test_max_active_keys_none_means_no_cap(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin = _mint(client, subject="alice", tenant="acme")

    # Set a TTL cap but no active-key cap.
    r_set = client.put(
        "/v1/workspace/api-key-policy",
        json={"max_ttl_seconds": 365 * DAY, "require_expiry": False},
        headers={"Authorization": f"Bearer {admin}"},
    )
    assert r_set.status_code == 200, r_set.text
    assert r_set.json()["max_active_keys"] is None

    # Mint several keys without tripping any active-key cap. The plan
    # seat ceiling still applies independently; keep this within the
    # default plan to prove only the absence of the admin cap.
    for name in ("k1", "k2"):
        rr = client.post(
            "/v1/admin/api-keys",
            json={"name": name, "role": "viewer", "tenant_id": "acme"},
            headers={"x-api-key": "adm"},
        )
        assert rr.status_code == 201, rr.text
