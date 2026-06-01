"""Integration test: per-workspace enforce-SSO policy.

Proves the enterprise guarantee that a workspace owner can require
SSO sign-in for their tenant, and that the gate bites every
authenticated route (not just the route the policy lives on).

Specifically:

1. With no policy set, a password-issued JWT and an env-mapped API key
   both work against a viewer endpoint.
2. After ``PUT /v1/workspace/sso-enforcement {require_sso: true}``, a
   token freshly minted via ``/v1/admin/token`` (auth_method=password)
   is rejected with 403 ``sso_required`` on its very next call.
3. A token whose ``auth_method`` claim is ``sso`` (mirroring the
   ``/v1/admin/sso/oidc/exchange`` mint path) still works in the same
   tenant.
4. The policy is tenant-scoped: capping ``acme`` does not affect a
   password token minted for ``globex``.
5. A subject on the break-glass allow-list passes the gate even with a
   password token, and the bypass is written to the admin audit log.
6. Every mutation lands in the admin audit log so SOC2 reviewers can
   trace who flipped the toggle and when.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from adherence_common.settings import reload_settings


def _setup_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ADHERENCE_API_KEYS", "admin:adm,service:svc,viewer:vwr")
    monkeypatch.setenv("ADHERENCE_JWT_SECRET", "x" * 32)
    monkeypatch.setenv("ADHERENCE_MODEL_REGISTRY", str(tmp_path / "reg"))
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/ssoenf.db")
    monkeypatch.setenv("ADHERENCE_MLFLOW_TRACKING_URI", f"file:{tmp_path}/mlruns")
    monkeypatch.setenv("ADHERENCE_RATE_LIMIT_ENABLED", "false")
    reload_settings()
    from adherence_common import audit as audit_mod
    audit_mod._INITIALIZED = False
    from adherence_common import db as db_mod
    db_mod._engine.cache_clear()
    db_mod._session_factory.cache_clear()
    db_mod.init_db()


def _mint_password(client: TestClient, *, subject: str, tenant: str, role: str = "viewer") -> str:
    r = client.post(
        "/v1/admin/token",
        json={"subject": subject, "role": role, "tenant": tenant},
        headers={"x-api-key": "adm"},
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _mint_sso(*, subject: str, tenant: str, role: str = "viewer") -> str:
    """Mint a JWT that mimics what /v1/admin/sso/oidc/exchange produces.

    Goes through the same helper the SSO route uses so the auth_method
    claim is set the same way in production.
    """
    from adherence_common.auth import mint_jwt
    from adherence_common.settings import get_settings
    return mint_jwt(
        subject,
        role,  # type: ignore[arg-type]
        get_settings(),
        tenant=tenant,
        auth_method="sso",
    )


def _admin_password(client: TestClient, tenant: str) -> str:
    return _mint_password(client, subject=f"admin-{tenant}", tenant=tenant, role="admin")


def _viewer_call(client: TestClient, *, token: str | None = None, api_key: str | None = None):
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if api_key:
        headers["x-api-key"] = api_key
    return client.get("/v1/quota/me", headers=headers)


def test_enforce_sso_blocks_password_token_and_allows_sso_token(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    # Baseline: no policy, both credential types work for acme.
    pw_tok_acme = _mint_password(client, subject="alice", tenant="acme")
    assert _viewer_call(client, token=pw_tok_acme).status_code == 200
    assert _viewer_call(client, api_key="vwr").status_code == 200  # tenant=default

    # Flip enforce-SSO on for acme via the SSO route. Use an SSO-issued
    # admin token so the toggle itself isn't blocked by its own gate.
    sso_admin_acme = _mint_sso(subject="sso:okta:alice@acme.test", tenant="acme", role="admin")
    r_set = client.put(
        "/v1/workspace/sso-enforcement",
        json={"require_sso": True, "break_glass_subjects": ["break-glass-alice"]},
        headers={"Authorization": f"Bearer {sso_admin_acme}"},
    )
    assert r_set.status_code == 200, r_set.text
    assert r_set.json()["require_sso"] is True
    assert "break-glass-alice" in r_set.json()["break_glass_subjects"]

    # The previously-valid password token is now rejected on the very
    # next call. No need to mint a new one.
    r_blocked = _viewer_call(client, token=pw_tok_acme)
    assert r_blocked.status_code == 403, r_blocked.text
    body = r_blocked.json()
    assert body["detail"]["code"] == "sso_required"
    assert body["detail"]["tenant"] == "acme"

    # An SSO-issued token in the same tenant still works.
    sso_viewer_acme = _mint_sso(subject="sso:okta:bob@acme.test", tenant="acme")
    assert _viewer_call(client, token=sso_viewer_acme).status_code == 200

    # Tenant isolation: globex was never touched, so its password token
    # is unaffected.
    pw_tok_globex = _mint_password(client, subject="carol", tenant="globex")
    assert _viewer_call(client, token=pw_tok_globex).status_code == 200

    # Break-glass subject can use a password token and bypass the gate.
    bg_tok = _mint_password(client, subject="break-glass-alice", tenant="acme")
    r_bg = _viewer_call(client, token=bg_tok)
    assert r_bg.status_code == 200, r_bg.text

    # The bypass was recorded in the admin audit log.
    r_audit_bg = client.get(
        "/v1/admin/audit/admin?action=sso.enforcement.break_glass&tenant=*&limit=5",
        headers={"x-api-key": "adm"},
    )
    assert r_audit_bg.status_code == 200, r_audit_bg.text
    bg_actions = [row["action"] for row in r_audit_bg.json()]
    assert "sso.enforcement.break_glass" in bg_actions

    # The set call itself was audited.
    r_audit = client.get(
        "/v1/admin/audit/admin?action=workspace.sso_enforcement.set&tenant=*&limit=5",
        headers={"x-api-key": "adm"},
    )
    assert r_audit.status_code == 200, r_audit.text
    actions = [row["action"] for row in r_audit.json()]
    assert "workspace.sso_enforcement.set" in actions

    # Clearing the policy lifts the gate.
    sso_admin_acme2 = _mint_sso(subject="sso:okta:alice@acme.test", tenant="acme", role="admin")
    r_del = client.delete(
        "/v1/workspace/sso-enforcement",
        headers={"Authorization": f"Bearer {sso_admin_acme2}"},
    )
    assert r_del.status_code == 200, r_del.text
    fresh_pw = _mint_password(client, subject="alice", tenant="acme")
    assert _viewer_call(client, token=fresh_pw).status_code == 200


def test_enforce_sso_requires_admin_to_mutate(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    # Viewers can read the policy (a buyer's IT team needs visibility).
    r_get = client.get(
        "/v1/workspace/sso-enforcement",
        headers={"x-api-key": "vwr"},
    )
    assert r_get.status_code == 200, r_get.text

    # Viewers cannot toggle it.
    r_put = client.put(
        "/v1/workspace/sso-enforcement",
        json={"require_sso": True, "break_glass_subjects": []},
        headers={"x-api-key": "vwr"},
    )
    assert r_put.status_code in (401, 403), r_put.text


def test_enforce_sso_validates_break_glass_list(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())

    admin_tok = _mint_password(client, subject="admin-x", tenant="acme", role="admin")
    # Pydantic rejects an over-long list with 422 before we even hit the
    # set_policy helper.
    too_many = [f"s{i}" for i in range(20)]
    r = client.put(
        "/v1/workspace/sso-enforcement",
        json={"require_sso": True, "break_glass_subjects": too_many},
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r.status_code == 422, r.text
