"""Integration tests for workspace verified email domains and SSO auto-join.

Procurement-blocker invariants:

1. Tenant scoping: ``acme`` admin cannot list, create, mutate, or delete
   ``globex`` workspace's verified domains.
2. RBAC: viewers can list but cannot mutate verified-domain records.
3. ``resolve_auto_join`` refuses to choose a winner when two workspaces
   claim the same enabled domain.
4. SSO exchange honours a workspace-owned verified-domain claim and
   creates a real membership row in the claiming tenant.
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
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/verified.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint(client: TestClient, subject: str, role: str, tenant: str) -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_verified_domain_tenant_isolation(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")
    globex_admin = _mint(client, "owner@globex.test", "admin", "globex")

    # Acme claims acme.test.
    r = client.post(
        "/v1/workspace/verified-domains",
        json={"domain": "acme.test", "default_role": "viewer",
              "auto_join_enabled": True},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201, r.text
    assert r.json()["tenant_id"] == "acme"
    assert r.json()["domain"] == "acme.test"

    # Globex claims globex.test.
    r = client.post(
        "/v1/workspace/verified-domains",
        json={"domain": "globex.test", "default_role": "admin"},
        headers=_h(globex_admin),
    )
    assert r.status_code == 201, r.text

    # Acme lists only its own claim. No cross-tenant peek.
    r = client.get("/v1/workspace/verified-domains", headers=_h(acme_admin))
    assert r.status_code == 200, r.text
    rows = r.json()["domains"]
    assert [row["domain"] for row in rows] == ["acme.test"]

    # Globex sees only its claim.
    r = client.get("/v1/workspace/verified-domains", headers=_h(globex_admin))
    assert [row["domain"] for row in r.json()["domains"]] == ["globex.test"]

    # Acme cannot delete Globex's claim. Treated as not-found in its scope.
    r = client.delete(
        "/v1/workspace/verified-domains/globex.test", headers=_h(acme_admin),
    )
    assert r.status_code == 404, r.text

    # Globex's claim still present and untouched.
    r = client.get("/v1/workspace/verified-domains", headers=_h(globex_admin))
    assert [row["domain"] for row in r.json()["domains"]] == ["globex.test"]


def test_verified_domain_rbac_viewer_cannot_mutate(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app

    client = TestClient(create_app())
    acme_viewer = _mint(client, "viewer@acme.test", "viewer", "acme")

    r = client.get("/v1/workspace/verified-domains", headers=_h(acme_viewer))
    assert r.status_code == 200, r.text  # viewers may read

    r = client.post(
        "/v1/workspace/verified-domains",
        json={"domain": "acme.test"},
        headers=_h(acme_viewer),
    )
    assert r.status_code in (401, 403), r.text


def test_resolve_auto_join_refuses_ambiguous_claims(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_common import verified_domains as vd

    vd.add_domain("acme", "shared.test", default_role="viewer", auto_join_enabled=True)
    vd.add_domain("globex", "shared.test", default_role="admin", auto_join_enabled=True)

    # Two enabled claims on the same domain: no winner.
    assert vd.resolve_auto_join("alice@shared.test") is None

    # Disabling one resolves the ambiguity.
    vd.update_domain("globex", "shared.test", auto_join_enabled=False)
    r = vd.resolve_auto_join("alice@shared.test")
    assert r is not None
    assert r.tenant_id == "acme"
    assert r.role == "viewer"

    # Unknown domain returns None.
    assert vd.resolve_auto_join("bob@nope.test") is None
    assert vd.resolve_auto_join("garbage") is None


def test_sso_exchange_auto_joins_via_verified_domain(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    from adherence_common import verified_domains as vd
    from adherence_common import oidc as oidc_mod
    from adherence_common import memberships as mem

    # Workspace owner self-serves a verified domain.
    vd.add_domain("acme", "acme.test", default_role="admin", auto_join_enabled=True)

    # Stub the IdP signature verification. We only test the wiring
    # downstream of identity verification.
    def _fake_verify(id_token, provider_name, settings):
        return oidc_mod.OidcIdentity(
            sub="abc-123",
            email="new.hire@acme.test",
            email_verified=True,
            name="New Hire",
            issuer="https://accounts.google.test",
            provider=provider_name,
            raw_claims={},
        )

    monkeypatch.setattr(oidc_mod, "verify_id_token", _fake_verify)
    # The sso route imports verify_id_token by name, so patch the bound
    # symbol there too.
    from adherence_api.routes import sso as sso_route
    monkeypatch.setattr(sso_route, "verify_id_token", _fake_verify)

    client = TestClient(create_app())
    r = client.post(
        "/v1/admin/sso/oidc/exchange",
        json={"provider": "google", "id_token": "stub-id-token-for-testing-only"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tenant"] == "acme", body
    assert body["role"] == "admin", body
    assert body["email"] == "new.hire@acme.test"

    # Membership row was created in the claiming workspace.
    members = mem.list_members("acme")
    subs = {m.subject for m in members}
    assert any("new.hire@acme.test" in s for s in subs), subs

    # Re-running does not duplicate the membership row.
    r = client.post(
        "/v1/admin/sso/oidc/exchange",
        json={"provider": "google", "id_token": "stub-id-token-for-testing-only"},
    )
    assert r.status_code == 200, r.text
    members2 = mem.list_members("acme")
    assert len(members2) == len(members)
