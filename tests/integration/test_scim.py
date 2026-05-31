"""Integration tests for SCIM 2.0 provisioning.

Procurement-blocker invariants:

1. Tenant scoping: a SCIM token minted for ``acme`` cannot read, create,
   replace, patch, or delete members of ``globex`` — even if the IdP
   ships a payload that names a globex user.
2. AuthN: requests without a bearer token are rejected 401 with a SCIM
   error envelope.
3. RBAC on token management: a viewer cannot mint, list, or revoke SCIM
   tokens.
4. Audit: every SCIM provisioning mutation lands in ``admin_audit_log``
   with the tenant of the calling token.
5. De-provisioning: ``DELETE /scim/v2/Users/{id}`` and ``PATCH`` with
   ``active=false`` both remove the workspace membership.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv(
        "ADHERENCE_API_KEYS",
        "admin:adm,service:svc,viewer:vwr",
    )
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/scim.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint_jwt(client: TestClient, subject: str, role: str, tenant: str) -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _mint_scim(client: TestClient, jwt: str, name: str) -> str:
    r = client.post(
        "/v1/admin/scim/tokens",
        json={"name": name},
        headers=_h(jwt),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["token"].startswith("scim_"), body
    return body["token"]


def test_scim_token_missing_bearer_returns_401(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    r = client.get("/scim/v2/Users")
    assert r.status_code == 401, r.text
    assert "scim:api:messages" in r.text


def test_scim_provisioning_is_tenant_scoped(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    acme_admin = _mint_jwt(client, "owner@acme.test", "admin", "acme")
    globex_admin = _mint_jwt(client, "owner@globex.test", "admin", "globex")

    acme_scim = _mint_scim(client, acme_admin, "okta")
    globex_scim = _mint_scim(client, globex_admin, "okta")

    # IdP provisions alice into acme via SCIM.
    r = client.post(
        "/scim/v2/Users",
        json={
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
            "userName": "alice@acme.test",
            "active": True,
            "roles": [{"value": "viewer", "primary": True}],
        },
        headers=_h(acme_scim),
    )
    assert r.status_code == 201, r.text
    alice = r.json()
    assert alice["userName"] == "alice@acme.test"
    assert alice["roles"][0]["value"] == "viewer"

    # Globex's IdP cannot see alice through its own SCIM token.
    r = client.get("/scim/v2/Users", headers=_h(globex_scim))
    assert r.status_code == 200, r.text
    subs = [u["userName"] for u in r.json()["Resources"]]
    assert "alice@acme.test" not in subs

    # Filter by userName from globex also returns nothing.
    r = client.get(
        '/scim/v2/Users?filter=userName eq "alice@acme.test"',
        headers=_h(globex_scim),
    )
    assert r.status_code == 200, r.text
    assert r.json()["totalResults"] == 0

    # Globex cannot fetch alice by id even if it guesses the integer.
    r = client.get(f"/scim/v2/Users/{alice['id']}", headers=_h(globex_scim))
    assert r.status_code == 404, r.text

    # Globex cannot delete alice. Membership in acme survives.
    r = client.delete(f"/scim/v2/Users/{alice['id']}", headers=_h(globex_scim))
    assert r.status_code == 404, r.text

    r = client.get(f"/scim/v2/Users/{alice['id']}", headers=_h(acme_scim))
    assert r.status_code == 200, r.text


def test_scim_patch_deactivate_removes_membership_and_audits(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_common.admin_audit import list_admin_actions

    client = TestClient(create_app())
    acme_admin = _mint_jwt(client, "owner@acme.test", "admin", "acme")
    acme_scim = _mint_scim(client, acme_admin, "azure-ad")

    r = client.post(
        "/scim/v2/Users",
        json={"userName": "bob@acme.test", "active": True},
        headers=_h(acme_scim),
    )
    assert r.status_code == 201, r.text
    bob_id = r.json()["id"]

    # Deactivate via PATCH active=false (Azure AD style).
    r = client.patch(
        f"/scim/v2/Users/{bob_id}",
        json={
            "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            "Operations": [
                {"op": "replace", "path": "active", "value": False}
            ],
        },
        headers=_h(acme_scim),
    )
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False

    # Member is gone from the workspace.
    from adherence_common import memberships as mem
    assert mem.get_member("acme", "bob@acme.test") is None

    # Audit trail captured the deactivate under the right tenant.
    actions = [row["action"] for row in list_admin_actions(limit=20, tenant_id="acme")]
    assert "scim.user.create" in actions
    assert "scim.user.deactivate" in actions


def test_scim_token_management_requires_admin(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    viewer = _mint_jwt(client, "viewer@acme.test", "viewer", "acme")

    r = client.post(
        "/v1/admin/scim/tokens",
        json={"name": "okta"},
        headers=_h(viewer),
    )
    assert r.status_code in (401, 403), r.text

    r = client.get("/v1/admin/scim/tokens", headers=_h(viewer))
    assert r.status_code in (401, 403), r.text


def test_scim_revoked_token_cannot_provision(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    acme_admin = _mint_jwt(client, "owner@acme.test", "admin", "acme")
    scim_token = _mint_scim(client, acme_admin, "okta")

    # Find and revoke the token.
    r = client.get("/v1/admin/scim/tokens", headers=_h(acme_admin))
    assert r.status_code == 200, r.text
    tok_id = r.json()["tokens"][0]["id"]
    r = client.delete(f"/v1/admin/scim/tokens/{tok_id}", headers=_h(acme_admin))
    assert r.status_code == 200, r.text

    # Revoked token now fails 401.
    r = client.get("/scim/v2/Users", headers=_h(scim_token))
    assert r.status_code == 401, r.text
