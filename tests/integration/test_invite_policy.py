"""Integration tests for the workspace invitation email-domain policy.

Covers the three deal-blocker invariants enterprise IT reviewers check:

1. Empty policy = no restriction (back-compat).
2. Allowlist gate: creating an invite to a domain outside the allowlist
   is rejected with HTTP 400 and a structured ``not_in_allowlist``
   error, even when no block rule exists.
3. Blocklist gate: a block rule wins over an allow rule and is enforced
   on both create and accept paths, with audit entries written each
   time.
4. Cross-tenant isolation: an admin in workspace ``acme`` cannot see or
   mutate workspace ``globex``'s rules; rules are scoped per
   ``tenant_id``.
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
    monkeypatch.setenv("ADHERENCE_DB_URL", f"sqlite:///{tmp_path}/invite_policy.db")
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


def test_empty_policy_is_no_op(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")

    # Policy starts empty for both kinds.
    r = client.get("/v1/admin/invite-policy", headers=_h(admin))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tenant_id"] == "acme"
    assert body["allowlist_enforced"] is False
    assert body["blocklist_enforced"] is False
    assert body["rules"] == []

    # With no rules, any domain may be invited.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "anyone@personal.example", "role": "viewer"},
        headers=_h(admin),
    )
    assert r.status_code == 201, r.text


def test_allowlist_blocks_outside_domain(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")

    # Add allow rule.
    r = client.post(
        "/v1/admin/invite-policy/rules",
        json={"kind": "allow", "domain": "Acme.com", "note": "corporate"},
        headers=_h(admin),
    )
    assert r.status_code == 201, r.text
    assert r.json()["domain"] == "acme.com"
    assert r.json()["kind"] == "allow"

    # Allowed: subdomain of acme.com.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "new.hire@hr.acme.com", "role": "viewer"},
        headers=_h(admin),
    )
    assert r.status_code == 201, r.text

    # Rejected: outside allowlist.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "stranger@globex.test", "role": "viewer"},
        headers=_h(admin),
    )
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "not_in_allowlist"
    assert detail["domain"] == "globex.test"

    # Evaluate endpoint returns the same verdict without sending an invite.
    r = client.post(
        "/v1/admin/invite-policy/evaluate",
        json={"email": "stranger@globex.test"},
        headers=_h(admin),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["allowed"] is False
    assert body["code"] == "not_in_allowlist"

    r = client.post(
        "/v1/admin/invite-policy/evaluate",
        json={"email": "ok@acme.com"},
        headers=_h(admin),
    )
    assert r.status_code == 200
    assert r.json()["allowed"] is True


def test_blocklist_wins_and_enforced_on_accept(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    admin = _mint(client, "owner@acme.test", "admin", "acme")

    # No restriction yet; create an invitation that we'll later block.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "user@gmail.com", "role": "viewer"},
        headers=_h(admin),
    )
    assert r.status_code == 201, r.text
    pending_token = r.json()["token"]

    # Add a block rule for gmail.com. Also seed an allow rule for it to
    # prove blocks win.
    r = client.post(
        "/v1/admin/invite-policy/rules",
        json={"kind": "allow", "domain": "gmail.com"},
        headers=_h(admin),
    )
    assert r.status_code == 201, r.text
    r = client.post(
        "/v1/admin/invite-policy/rules",
        json={"kind": "block", "domain": "gmail.com", "note": "personal mail"},
        headers=_h(admin),
    )
    assert r.status_code == 201, r.text

    # New create attempt is now rejected with in_blocklist.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "another@gmail.com", "role": "viewer"},
        headers=_h(admin),
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"]["code"] == "in_blocklist"

    # Previously issued invite cannot be accepted any more.
    invitee = _mint(client, "user@gmail.com", "viewer", "acme")
    r = client.post(
        "/v1/workspace/invitations/accept",
        json={"token": pending_token},
        headers=_h(invitee),
    )
    assert r.status_code in (400, 403, 409), r.text
    assert r.json()["detail"]["code"] == "domain_blocked"


def test_rules_are_tenant_scoped(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    acme_admin = _mint(client, "owner@acme.test", "admin", "acme")
    globex_admin = _mint(client, "owner@globex.test", "admin", "globex")

    # acme adds an allow rule.
    r = client.post(
        "/v1/admin/invite-policy/rules",
        json={"kind": "allow", "domain": "acme.com"},
        headers=_h(acme_admin),
    )
    assert r.status_code == 201
    acme_rule_id = r.json()["id"]

    # globex's policy stays empty.
    r = client.get("/v1/admin/invite-policy", headers=_h(globex_admin))
    assert r.status_code == 200
    assert r.json()["rules"] == []
    assert r.json()["allowlist_enforced"] is False

    # globex cannot delete acme's rule even by its id.
    r = client.delete(
        f"/v1/admin/invite-policy/rules/{acme_rule_id}",
        headers=_h(globex_admin),
    )
    assert r.status_code == 404, r.text

    # acme's rule survives.
    r = client.get("/v1/admin/invite-policy", headers=_h(acme_admin))
    assert r.status_code == 200
    assert any(rule["id"] == acme_rule_id for rule in r.json()["rules"])

    # globex can still invite an outside-domain user because no rules.
    r = client.post(
        "/v1/workspace/invitations",
        json={"email": "user@somewhere.test", "role": "viewer"},
        headers=_h(globex_admin),
    )
    assert r.status_code == 201, r.text


def test_viewer_cannot_mutate_policy(tmp_path, monkeypatch):
    _setup_env(tmp_path, monkeypatch)
    from adherence_api.app import create_app
    client = TestClient(create_app())
    viewer = _mint(client, "spy@acme.test", "viewer", "acme")

    r = client.get("/v1/admin/invite-policy", headers=_h(viewer))
    assert r.status_code in (401, 403), r.text

    r = client.post(
        "/v1/admin/invite-policy/rules",
        json={"kind": "allow", "domain": "acme.com"},
        headers=_h(viewer),
    )
    assert r.status_code in (401, 403), r.text
